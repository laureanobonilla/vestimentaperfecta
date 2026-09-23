// netlify/functions/generate-outfit.js
const cloudinary = require('cloudinary').v2;
const { v4: uuidv4 } = require('uuid');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

global.sessionsDb = global.sessionsDb || {};

exports.handler = async (event) => {
  console.log('[TEMPORAL MODE] Subiendo foto original y solicitando mejor calidad');

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { imageBase64 } = JSON.parse(event.body || '{}');
    if (!imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No se envió ninguna imagen.' }) };
    }

    const sessionId = uuidv4();
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // 1. Subir la foto original del usuario a Cloudinary para guardarla en los registros
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });

    console.log('[UPLOAD OK] Foto original guardada con ID:', originalUpload.public_id);

    // Simulamos un breve retraso para dar realismo al análisis
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2. Devolvemos un código 400 controlado para que el frontend no avance al pago,
    // muestre la alerta y permita al usuario subir una foto más clara.
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: "Para garantizar un resultado de alta costura impecable, por favor envía una imagen más clara y con mejor iluminación frontal." 
      })
    };

  } catch (error) {
    console.error('[ERROR TEMPORAL]:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Error al procesar la imagen en el servidor.' })
    };
  }
};