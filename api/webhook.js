const { GoogleSpreadsheet } = require('google-spreadsheet');
const axios = require('axios');

// CONFIGURACIÓN
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

module.exports = async (req, res) => {
  // 1. VERIFICACIÓN DE META (GET)
  if (req.method === 'GET') {
    if (req.query['hub.verify_token'] === 'tribu_token_seguro') {
      return res.status(200).send(req.query['hub.challenge']);
    }
    return res.status(403).send('Error de token');
  }

  // 2. RECEPCIÓN DE MENSAJES (POST)
  if (req.method === 'POST') {
    try {
      const body = req.body;
      
      // Verificación de seguridad básica de la estructura del JSON
      if (!body.entry || !body.entry[0].changes || !body.entry[0].changes[0].value.messages) {
        return res.status(200).send('No es un mensaje procesable');
      }

      const messageObj = body.entry[0].changes[0].value.messages[0];
      const from = messageObj.from; 
      const text = messageObj.text.body.trim(); 

      console.log(`📩 Mensaje recibido de ${from}: ${text}`); // Log en Vercel

      await procesarMensaje(from, text);
      return res.status(200).send('EVENT_RECEIVED');

    } catch (error) {
      console.error("🔥 Error Fatal:", error);
      // Respondemos 200 aunque falle para que WhatsApp no reintente infinitamente
      return res.status(200).send('EVENT_RECEIVED_WITH_ERROR');
    }
  }
};

// FUNCIÓN PRINCIPAL DE LÓGICA
async function procesarMensaje(telefono, mensaje) {
  try {
    const doc = new GoogleSpreadsheet(SHEET_ID);
    await doc.useServiceAccountAuth({
        client_email: CLIENT_EMAIL,
        private_key: PRIVATE_KEY,
    });
    await doc.loadInfo();

    const hojaInventario = doc.sheetsByTitle['Inventario'];
    const hojaMovimientos = doc.sheetsByTitle['Movimientos'];
    
    const filas = await hojaInventario.getRows();

    // REGEX
    const regexEntrada = /^([A-Za-z0-9]+)\s+(\d+)$/; 
    const regexSalida = /^Salida\s+([A-Za-z0-9]+)\s+(\d+)\s+(.+)$/i;

    let respuesta = "";

    // --- LÓGICA DE ENTRADA ---
    if (mensaje.match(regexEntrada)) {
        const match = mensaje.match(regexEntrada);
        const ref = match[1].toUpperCase();
        const cant = parseInt(match[2]);

        // Buscamos usando el nombre de la columna "Referencia"
        // Asegúrate que en A1 pusiste "Referencia"
        const filaEncontrada = filas.find(row => row.Referencia === ref);

        if (filaEncontrada) {
            const saldoActual = parseInt(filaEncontrada.Cantidad || 0);
            const nuevoSaldo = saldoActual + cant;
            
            filaEncontrada.Cantidad = nuevoSaldo; 
            await filaEncontrada.save();

            await hojaMovimientos.addRow({
                'Fecha': new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
                'Accion': 'Entrada',
                'Referencia': ref,
                'Cantidad': cant,
                'Nota': 'Producción'
            });
            console.log(`✅ Inventario actualizado: ${ref} ahora tiene ${nuevoSaldo}`);
            respuesta = `✅ *ENTRADA REGISTRADA* Ref: ${ref} Nuevo Saldo: ${nuevoSaldo}`;
        } else {
            console.log(`❌ Referencia no encontrada: ${ref}`);
            respuesta = `❌ Error: La referencia ${ref} no existe.`;
        }

    // --- LÓGICA DE SALIDA ---
    } else if (mensaje.match(regexSalida)) {
        const match = mensaje.match(regexSalida);
        const ref = match[1].toUpperCase();
        const cant = parseInt(match[2]);
        const obra = match[3];

        const filaEncontrada = filas.find(row => row.Referencia === ref);

        if (filaEncontrada) {
            const saldoActual = parseInt(filaEncontrada.Cantidad || 0);
            if (saldoActual < cant) {
                respuesta = `⚠️ Sin stock suficiente. Tienes: ${saldoActual}`;
            } else {
                const nuevoSaldo = saldoActual - cant;
                filaEncontrada.Cantidad = nuevoSaldo;
                await filaEncontrada.save();

                await hojaMovimientos.addRow({
                    'Fecha': new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
                    'Accion': 'Salida',
                    'Referencia': ref,
                    'Cantidad': cant,
                    'Nota': obra
                });
                respuesta = `🚚 *SALIDA REGISTRADA* Destino: ${obra} Quedan: ${nuevoSaldo}`;
            }
        } else {
            respuesta = `❌ Error: Referencia ${ref} no encontrada.`;
        }
    } else {
        respuesta = "🤖 Comandos: 'A10 50' o 'Salida A10 20 Obra'";
    }

    // INTENTO DE ENVIAR WHATSAPP (Protegido para que no tumbe el servidor)
    try {
        if (process.env.WHATSAPP_TOKEN === 'PENDIENTE') {
            console.log("⚠️ Modo Prueba: No se envía WhatsApp porque el token es PENDIENTE.");
            console.log("🤖 El bot hubiera respondido:", respuesta);
        } else {
            await enviarWhatsApp(telefono, respuesta);
        }
    } catch (wsError) {
        console.error("Error enviando WhatsApp (No crítico):", wsError.message);
    }

  } catch (error) {
    console.error("❌ Error en procesarMensaje:", error);
    throw error; // Este sí es crítico
  }
}

async function enviarWhatsApp(telefono, texto) {
  const url = `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  await axios.post(url, {
    messaging_product: "whatsapp",
    to: telefono,
    type: "text",
    text: { body: texto }
  }, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}
