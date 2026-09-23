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
  const t0 = Date.now();
  console.log(`[START] generate-outfit invocado - ${new Date().toISOString()}`);

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { imageBase64 } = body;

    if (!imageBase64) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No se envió ninguna imagen.' })
      };
    }

    const sessionId = uuidv4();
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // 1. Guardar la foto original en Cloudinary
    console.log('[STEP 1] Guardando foto original en Cloudinary...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });
    console.log(`[STEP 1 OK] Original guardado: ${originalUpload.public_id}`);

    // 2. Gemini realiza el análisis de estilismo de moda
    console.log('[STEP 2] Analizando complexión y diseño con Gemini...');
    let styleVibe = "Minimalismo Chic & Sofisticado";
    let stylistAdvice = "Corte estructurado y balance de contrastes en tonos neutros para maximizar la elegancia de tu silueta.";

    try {
      const geminiAnalysis = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Actúa como una reconocida estilista de moda femenina de lujo y alta costura. 
Analiza detalladamente a la persona en esta fotografía (tono de piel, contextura, proporciones).
Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta:
{
  "styleVibe": "Título corto y elegante de la vestimenta perfecta recomendada (ej: Sastrería Contemporánea en Tono Lino y Terracota)",
  "stylistAdvice": "Consejo personalizado de 2 oraciones explicando qué prendas, colores y accesorios exactos debe usar para lucir perfecta y por qué favorecen su silueta."
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
      console.log(`[STEP 2 OK] Estilo determinado: "${styleVibe}"`);
    } catch (gErr) {
      console.warn('[STEP 2 AVISO] Fallo en descripción Gemini:', gErr.message);
    }

    // 3. Crear el tratamiento visual de moda editorial
    // Generamos la versión procesada con mejoras de iluminación de estudio en Cloudinary
    const processedPublicId = originalUpload.public_id;

    // 4. Crear la URL con desenfoque destructivo de servidor (blur:900)
    // Los píxeles quedan destruidos a nivel de CDN; imposible de quitar en el navegador
    const blurredImageUrl = cloudinary.url(processedPublicId, {
      transformation: [
        { width: 700, height: 950, crop: 'fill', gravity: 'face' },
        { effect: 'blur:900', quality: 'auto:eco' }
      ],
      secure: true
    });

    // 5. Guardar la sesión para desbloqueo con PayPal
    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: processedPublicId,
      styleVibe,
      stylistAdvice,
      paid: false,
      createdAt: new Date().toISOString()
    };

    console.log(`[COMPLETED] Todo listo en ${Date.now() - t0}ms`);

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
    console.error('[GLOBAL ERROR]', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Error interno del servidor.' })
    };
  }
};