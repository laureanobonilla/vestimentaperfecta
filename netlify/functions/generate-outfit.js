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
  console.log('[TEMPORAL MODE] Solicitud recibida en modo de validación de imagen');

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

    // 1. Guardar la foto original en Cloudinary temporalmente
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });

    // 2. Crear una vista previa borrosa basada en la misma foto para mantener el flujo visual de la app
    const blurredImageUrl = cloudinary.url(originalUpload.public_id, {
      transformation: [
        { width: 600, height: 800, crop: 'fill' },
        { effect: 'blur:900', quality: 'auto:eco' }
      ],
      secure: true
    });

    // 3. Registrar sesión con un aviso de que la imagen necesita mayor claridad
    const styleVibe = "Imagen no concluyente";
    const stylistAdvice = "Por favor, sube una foto con mejor iluminación frontal y fondo limpio para que la inteligencia artificial pueda calibrar los detalles de tu outfit con precisión.";

    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: originalUpload.public_id,
      styleVibe,
      stylistAdvice,
      paid: false,
      createdAt: new Date().toISOString()
    };

    // Simulamos un breve retraso de procesamiento para dar realismo a la interfaz
    await new Promise(resolve => setTimeout(resolve, 1500));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        blurredImageUrl,
        styleSnippet: styleVibe,
        needsBetterImage: true,
        message: "Para garantizar un resultado de alta costura impecable, por favor envía una imagen más clara y con mejor iluminación."
      })
    };

  } catch (error) {
    console.error('[ERROR TEMPORAL]:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Error en el servidor.' })
    };
  }
};