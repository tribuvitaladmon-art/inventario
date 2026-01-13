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
    const filasInventario = await hojaInventario.getRows();

    // REGEX
    const regexOperacion = /^([A-Za-z0-9]+)\s+(-?\d+)(?:\s+(.+))?$/;
    
    let respuesta = "";

    // --- CASO 1: REPORTE DE INVENTARIO TOTAL ---
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

    // --- CASO 2: CONSULTAR ÚLTIMOS MOVIMIENTOS ---
    } else if (mensaje.match(/^movimientos$/i)) {
        const filasMov = await hojaMovimientos.getRows();
        const total = filasMov.length;
        
        if (total === 0) {
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

    // --- CASO 3: REGISTRAR ENTRADA/SALIDA ---
    } else if (mensaje.match(regexOperacion)) {
        const match = mensaje.match(regexOperacion);
        const ref = match[1].toUpperCase();     
        const cant = parseInt(match[2]);        
        const nota = match[3] || "Sin observaciones"; 

        // --- CORRECCIÓN AQUÍ: BÚSQUEDA ROBUSTA ---
        // Comparamos convirtiendo ambos lados a mayúsculas y borrando espacios
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
                
                await hojaMovimientos.addRow({
                    'Fecha': new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
                    'Accion': tipoAccion,
                    'Referencia': ref,
                    'Cantidad': cant,
                    'Nota': nota,
                    'Telefono': telefono 
                });

                if (cant > 0) {
                    respuesta = `✅ *PRODUCCIÓN*\nRef: ${ref}\nCant: +${cant}\nPersonal: ${nota}\n💰 Saldo: ${nuevoSaldo}`;
                } else {
                    respuesta = `🚚 *ENTREGA*\nRef: ${ref}\nCant: ${cant}\nDestino: ${nota}\n📉 Saldo: ${nuevoSaldo}`;
                }
            }
        } else {
            respuesta = `❌ La referencia ${ref} no existe.`;
        }

    } else {
        respuesta = "🤖 *Menú del Bot:*\n\n1️⃣ Operar: `A85 50 Jhon`\n2️⃣ Ver todo: `Inventario total`\n3️⃣ Historial: `Movimientos`";
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
