const { GoogleSpreadsheet } = require('google-spreadsheet');
const axios = require('axios');

// CONFIGURACIÓN DE VARIABLES
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
// Corrección crítica para la llave privada en Vercel
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

module.exports = async (req, res) => {
  // 1. VERIFICACIÓN DE META (Para cuando Meta te desbloquee)
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
      
      // Verificamos si viene la estructura correcta de WhatsApp
      if (!body.entry || !body.entry[0].changes || !body.entry[0].changes[0].value.messages) {
        return res.status(200).send('No es un mensaje de WhatsApp válido');
      }

      const messageObj = body.entry[0].changes[0].value.messages[0];
      const from = messageObj.from; 
      const text = messageObj.text.body.trim(); 

      console.log(`📩 MENSAJE RECIBIDO de ${from}: ${text}`); // ESTO SALDRÁ EN LOS LOGS

      // Procesamos la lógica (Excel)
      await procesarMensaje(from, text);
      
      // Respondemos ÉXITO a Meta (o a tu consola)
      return res.status(200).send('EVENT_RECEIVED');

    } catch (error) {
      // AQUÍ ESTÁ EL LOG DE FUEGO QUE BUSCAMOS
      console.error("🔥 Error Fatal en el Webhook:", error);
      // Respondemos 200 para no bloquear, pero registramos el error
      return res.status(200).send('EVENT_RECEIVED_WITH_ERROR');
    }
  }
};

// --- LÓGICA DEL NEGOCIO ---
async function procesarMensaje(telefono, mensaje) {
  try {
    // 1. Conexión a Google Sheets
    const doc = new GoogleSpreadsheet(SHEET_ID);
    await doc.useServiceAccountAuth({
        client_email: CLIENT_EMAIL,
        private_key: PRIVATE_KEY,
    });
    await doc.loadInfo();

    // 2. Seleccionar las pestañas
    const hojaInventario = doc.sheetsByTitle['Inventario'];
    const hojaMovimientos = doc.sheetsByTitle['Movimientos'];

    if (!hojaInventario || !hojaMovimientos) {
        throw new Error("No encuentro las pestañas 'Inventario' o 'Movimientos'. Revisa los nombres en Excel.");
    }
    
    const filas = await hojaInventario.getRows();

    // 3. Expresiones Regulares (Entender el texto)
    const regexEntrada = /^([A-Za-z0-9]+)\s+(\d+)$/;  // Ejemplo: A10 50
    const regexSalida = /^Salida\s+([A-Za-z0-9]+)\s+(\d+)\s+(.+)$/i; // Ejemplo: Salida A10 20 Obra

    let respuesta = "";

    // --- CASO 1: ENTRADA DE INVENTARIO ---
    if (mensaje.match(regexEntrada)) {
        const match = mensaje.match(regexEntrada);
        const ref = match[1].toUpperCase(); // La Referencia (A10)
        const cant = parseInt(match[2]);    // La Cantidad (50)

        // Buscar en la columna "Referencia"
        const filaEncontrada = filas.find(row => row.Referencia === ref);

        if (filaEncontrada) {
            const saldoActual = parseInt(filaEncontrada.Cantidad || 0);
            const nuevoSaldo = saldoActual + cant;
            
            // Guardar en Inventario
            filaEncontrada.Cantidad = nuevoSaldo; 
            await filaEncontrada.save();

            // Guardar en Movimientos
            await hojaMovimientos.addRow({
                'Fecha': new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
                'Accion': 'Entrada',
                'Referencia': ref,
                'Cantidad': cant,
                'Nota': 'Producción (WhatsApp)'
            });
            
            console.log(`✅ ÉXITO: Se sumaron ${cant} a ${ref}. Nuevo saldo: ${nuevoSaldo}`);
            respuesta = `✅ Entrada: ${ref} (+${cant}). Nuevo Saldo: ${nuevoSaldo}`;
        } else {
            console.warn(`⚠️ ALERTA: La referencia ${ref} no existe en la hoja.`);
            respuesta = `❌ Error: La referencia ${ref} no existe.`;
        }

    // --- CASO 2: SALIDA A OBRA ---
    } else if (mensaje.match(regexSalida)) {
        // ... (Lógica de salida, similar a la anterior)
        const match = mensaje.match(regexSalida);
        const ref = match[1].toUpperCase();
        const cant = parseInt(match[2]);
        const obra = match[3];

        const filaEncontrada = filas.find(row => row.Referencia === ref);

        if (filaEncontrada) {
            const saldoActual = parseInt(filaEncontrada.Cantidad || 0);
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
            respuesta = `🚚 Salida: ${ref} (-${cant}) para ${obra}. Quedan: ${nuevoSaldo}`;
        } else {
            respuesta = `❌ Error: La referencia ${ref} no existe.`;
        }
    } else {
        respuesta = "🤖 No entendí. Escribe 'A10 50' o 'Salida A10 20 Obra'";
    }

    // 4. ENVÍO DE RESPUESTA (Con protección para pruebas)
    if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN === 'PENDIENTE') {
        console.log("🟡 MODO PRUEBA (Sin Token): El bot hubiera respondido ->", respuesta);
    } else {
        await enviarWhatsApp(telefono, respuesta);
    }

  } catch (error) {
    // Si falla la conexión a Google o algo interno
    console.error("🔥 ERROR EN PROCESAR MENSAJE:", error);
    throw error; // Lanzamos el error para que salga en el log principal
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
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}
