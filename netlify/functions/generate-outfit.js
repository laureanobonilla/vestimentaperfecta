// netlify/functions/generate-outfit.js
const { GoogleGenAI } = require('@google/genai');
const cloudinary = require('cloudinary').v2;
const { v4: uuidv4 } = require('uuid');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
global.sessionsDb = global.sessionsDb || {};

exports.handler = async (event) => {
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

    // 1. Subir la foto original de la usuaria a Cloudinary
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });

    // 2. Gemini genera la asesoría de estilismo experta de alta gama
    let styleVibe = "Minimalismo Chic en Tonos Tierra";
    let stylistAdvice = "Para realzar tu silueta, opta por piezas de sastrería fluida en tonos crudos y accesorios dorados minimalistas. Esta combinación aporta una luminosidad impecable a tu rostro y equilibra tus proporciones naturales.";

    try {
      const geminiAnalysis = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Actúa como una directora de estilismo de una revista de alta moda (Vogue). Analiza a la persona en esta foto con criterio profesional.
Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta:
{
  "styleVibe": "Título sofisticado del concepto de moda ideal para ella",
  "stylistAdvice": "Consejo de 3 oraciones altamente profesional, detallando los cortes, tipos de tela, colores específicos y accesorios que transforman su imagen por completo."
}`
              }
            ]
          }
        ],
        config: { responseMimeType: 'application/json' }
      });

      const parsed = JSON.parse(geminiAnalysis.text);
      if (parsed.styleVibe) styleVibe = parsed.styleVibe;
      if (parsed.stylistAdvice) stylistAdvice = parsed.stylistAdvice;
    } catch (gErr) {
      console.warn("Aviso en Gemini:", gErr.message);
    }

    // 3. Crear una versión de estudio fotográfico profesional de su foto real
    // Cloudinary aplica corrección de color de revista y alta nitidez
    const enhancedUrl = cloudinary.url(originalUpload.public_id, {
      transformation: [
        { width: 800, height: 1066, crop: 'fill', gravity: 'face' },
        { effect: 'improve', quality: 'auto:best' },
        { effect: 'contrast:15', vibrance: 20 }
      ],
      secure: true
    });

    const enhancedUpload = await cloudinary.uploader.upload(enhancedUrl, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_enhanced`
    });

    // 4. Crear la vista previa con desenfoque destructivo de servidor (blur:900)
    const blurredImageUrl = cloudinary.url(enhancedUpload.public_id, {
      transformation: [
        { effect: 'blur:900', quality: 'auto:eco' }
      ],
      secure: true
    });

    // 5. Guardar sesión para el flujo de pago con PayPal
    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: enhancedUpload.public_id,
      styleVibe,
      stylistAdvice,
      paid: false,
      createdAt: new Date().toISOString()
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        blurredImageUrl,
        styleSnippet: styleVibe
      })
    };

  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Error al procesar la solicitud.' })
    };
  }
};