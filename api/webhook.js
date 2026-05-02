const { GoogleSpreadsheet } = require('google-spreadsheet');
const axios = require('axios');

// CONFIGURACIÓN
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (req.query['hub.verify_token'] === 'tribu_token_seguro') return res.status(200).send(req.query['hub.challenge']);
    return res.status(403).send('Error de token');
  }

  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (!body.entry || !body.entry[0].changes || !body.entry[0].changes[0].value.messages) return res.status(200).send('No procesable');

      const messageObj = body.entry[0].changes[0].value.messages[0];
      const from = messageObj.from; 
      const text = messageObj.text.body.trim(); 

      console.log(`📩 MENSAJE de ${from}: ${text}`); 
      await procesarMensaje(from, text);
      return res.status(200).send('EVENT_RECEIVED');

    } catch (error) {
      console.error("🔥 Error:", error);
      return res.status(200).send('EVENT_RECEIVED_WITH_ERROR');
    }
  }
};

async function procesarMensaje(telefono, mensaje) {
  try {
    const doc = new GoogleSpreadsheet(SHEET_ID);
    await doc.useServiceAccountAuth({ client_email: CLIENT_EMAIL, private_key: PRIVATE_KEY });
    await doc.loadInfo();

    const hojaInventario = doc.sheetsByTitle['Inventario'];
    const hojaMovimientos = doc.sheetsByTitle['Movimientos'];
    const hojaNomina = doc.sheetsByTitle['Nomina']; // NUEVA HOJA

    const filasInventario = await hojaInventario.getRows();
    const regexOperacion = /^(\S+)\s+(-?\d+)(?:\s+(.+))?$/;
    
    let respuesta = "";

    // --- COMANDO 1: REPORTE DE INVENTARIO TOTAL ---
    if (mensaje.match(/^(inventario total|reporte|saldo)$/i)) {
        let reporte = "📦 *INVENTARIO ACTUAL*\n------------------\n";
        let totalItems = 0;
        filasInventario.forEach(fila => {
            if (fila.Referencia) {
                reporte += `🔹 *${fila.Referencia}*: ${fila.Cantidad || 0}\n`;
                totalItems++;
            }
        });
        respuesta = totalItems === 0 ? "📭 El inventario está vacío." : reporte;

    // --- COMANDO 2: CONSULTAR MOVIMIENTOS ---
    } else if (mensaje.match(/^movimientos$/i)) {
        const filasMov = await hojaMovimientos.getRows();
        if (filasMov.length === 0) {
            respuesta = "📭 No hay movimientos registrados aún.";
        } else {
            const ultimos = filasMov.slice(-20).reverse(); 
            respuesta = "📋 *ÚLTIMOS 20 MOVIMIENTOS*\n------------------\n";
            ultimos.forEach(row => {
                const fechaCorta = row.Fecha ? row.Fecha.split(',')[0] : 'Hoy';
                const signo = parseInt(row.Cantidad) > 0 ? '+' : '';
                respuesta += `🗓️ ${fechaCorta} | *${row.Referencia}*: ${signo}${row.Cantidad}\n👤 ${row.Nota} (Tel: ${row.Telefono || '?'})\n\n`;
            });
        }

    // --- COMANDO NUEVO: PAGAR A TRABAJADOR ---
    } else if (mensaje.match(/^pagar\s+(.+)$/i)) {
        const nombreTrabajador = mensaje.match(/^pagar\s+(.+)$/i)[1].trim().toUpperCase();
        const filasNomina = await hojaNomina.getRows();
        
        const filaTrabajador = filasNomina.find(row => row.Trabajador && row.Trabajador.toUpperCase() === nombreTrabajador);
        
        if (filaTrabajador) {
            const montoPagado = filaTrabajador['Saldo Acumulado'] || 0;
            filaTrabajador['Saldo Acumulado'] = 0;
            filaTrabajador['Ultimo Pago'] = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
            await filaTrabajador.save();
            
            respuesta = `💸 *PAGO REGISTRADO*\n------------------\nSe ha liquidado y puesto en ceros la cuenta de *${nombreTrabajador}*.\nMonto liquidado: $${montoPagado}`;
        } else {
            respuesta = `❌ No encontré saldos pendientes para el trabajador: ${nombreTrabajador}`;
        }

    // --- COMANDO 3: REGISTRAR ENTRADA/SALIDA Y NÓMINA ---
    } else if (mensaje.match(regexOperacion)) {
        const match = mensaje.match(regexOperacion);
        const ref = match[1].toUpperCase();     
        const cant = parseInt(match[2]);        
        const nota = match[3] || "General"; 

        const filaEncontrada = filasInventario.find(row => 
            row.Referencia && row.Referencia.toString().trim().toUpperCase() === ref
        );

        if (filaEncontrada) {
            const saldoActual = parseInt(filaEncontrada.Cantidad || 0);
            
            if (cant < 0 && (saldoActual + cant) < 0) {
                respuesta = `⚠️ *ERROR DE STOCK*\nRef: ${ref}\nHay: ${saldoActual}\nIntentas sacar: ${Math.abs(cant)}`;
            } else {
                const nuevoSaldo = saldoActual + cant;
                filaEncontrada.Cantidad = nuevoSaldo;
                await filaEncontrada.save();

                const tipoAccion = cant >= 0 ? 'Entrada / Producción' : 'Salida / Entrega';
                
                // Guardar en Historial
                await hojaMovimientos.addRow({
                    'Fecha': new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
                    'Accion': tipoAccion,
                    'Referencia': ref,
                    'Cantidad': cant,
                    'Nota': nota,
                    'Telefono': telefono 
                });

                // LÓGICA DE NÓMINA (Solo aplica si hay un ingreso positivo y viene con nombres)
                let detallesNomina = "";
                if (cant > 0 && nota !== "General") {
                    const precioUnidad = parseFloat(filaEncontrada['Pago a trabajadores'] || 0);
                    const trabajadores = nota.trim().toUpperCase().split(/\s+/); // Separa los nombres por espacios
                    const pagoTotal = cant * precioUnidad;
                    
                    if (pagoTotal > 0 && trabajadores.length > 0) {
                        const pagoIndividual = pagoTotal / trabajadores.length;
                        const filasNomina = await hojaNomina.getRows();

                        detallesNomina = `\n\n👷‍♂️ *REPORTE DE PAGO:*\n💰 Total pieza: $${precioUnidad}\n💵 Reparto ($${pagoTotal} / ${trabajadores.length}):\n`;

                        for (const nombre of trabajadores) {
                            let filaTrabajador = filasNomina.find(row => row.Trabajador && row.Trabajador.toUpperCase() === nombre);
                            
                            if (filaTrabajador) {
                                // Sumar al saldo existente
                                let saldoPrevio = parseFloat(filaTrabajador['Saldo Acumulado'] || 0);
                                filaTrabajador['Saldo Acumulado'] = saldoPrevio + pagoIndividual;
                                await filaTrabajador.save();
                            } else {
                                // Crear nuevo trabajador
                                await hojaNomina.addRow({
                                    'Trabajador': nombre,
                                    'Saldo Acumulado': pagoIndividual,
                                    'Ultimo Pago': 'Nunca'
                                });
                            }
                            // Formateo visual sin decimales para pesos colombianos
                            detallesNomina += `👉 ${nombre}: +$${Math.round(pagoIndividual)}\n`;
                        }
                    }
                }

                // Generar Respuesta de Salida vs Entrada
                if (cant > 0) {
                    respuesta = `✅ *PRODUCCIÓN*\nRef: ${ref}\nCant: +${cant}\nPersonal: ${nota}\n📦 Stock Final: ${nuevoSaldo}${detallesNomina}`;
                } else {
                    respuesta = `🚚 *ENTREGA*\nRef: ${ref}\nCant: ${cant}\nDestino: ${nota}\n📉 Stock Final: ${nuevoSaldo}`;
                }
            }
        } else {
            respuesta = `❌ La referencia *${ref}* no existe en el inventario.`;
        }

    // --- COMANDO 4: TUTORIAL DETALLADO (Si ingresan algo mal) ---
    } else {
        respuesta = `🤖 *TUTORIAL DEL SISTEMA* 🤖\n\nNo reconocí ese comando. Aquí tienes ejemplos exactos de cómo pedirme las cosas:\n\n` +
        `🛠️ *1. Agregar Producción y calcular pago:*\nEscribe la Referencia, un espacio, la Cantidad, y los Nombres.\n👉 Ejemplo: \`A10MH 50 Jose Jaiver Jhon\`\n\n` +
        `🚚 *2. Registrar una Salida/Entrega:*\nUsa el signo MENOS antes del número, seguido del destino.\n👉 Ejemplo: \`A10MH -20 ObraCentro\`\n\n` +
        `📝 *3. Corregir un error (Reversión):*\nSi anotaste 50 por error, sácalos poniendo un menos.\n👉 Ejemplo: \`A10MH -50 CORRECCION\`\n\n` +
        `💸 *4. Pagar la quincena a un trabajador:*\n👉 Ejemplo: \`Pagar JOSE\`\n\n` +
        `📦 *5. Ver Inventario Completo:*\n👉 Escribe: \`Inventario total\`\n\n` +
        `📋 *6. Ver Historial:*\n👉 Escribe: \`Movimientos\``;
    }

    if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN === 'PENDIENTE') {
        console.log("🟡 BOT RESPONDE:", respuesta);
    } else {
        await enviarWhatsApp(telefono, respuesta);
    }

  } catch (error) {
    console.error("🔥 LÓGICA FALLÓ:", error);
    throw error;
  }
}

async function enviarWhatsApp(telefono, texto) {
  const url = `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  await axios.post(url, {
    messaging_product: "whatsapp",
    to: telefono,
    type: "text",
    text: { body: texto }
  }, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
}
