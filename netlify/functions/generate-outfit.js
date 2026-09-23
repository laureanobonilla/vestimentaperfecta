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
  console.log('[START] generate-outfit iniciado');

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (parseErr) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'El cuerpo de la petición no es un JSON válido.' })
      };
    }

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

    // 1. Guardar original en Cloudinary
    console.log('[1/4] Guardando foto original...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });

    // 2. Gemini redacta el concepto de estilismo
    console.log('[2/4] Diseñando look con Gemini...');
    let styleVibe = "Alta Costura Personalizada";
    let stylistAdvice = "Corte estructurado y paleta cálida que realzan tu presencia de manera natural.";
    let imagePrompt = "Full-length fashion editorial photography of an elegant woman wearing a bespoke luxury designer outfit matching skin tone and physique, professional studio lighting, Vogue aesthetic, 8k";

    try {
      const geminiAnalysis = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Actúa como estilista de alta moda femenina. Analiza a la persona en esta foto.
Devuelve ÚNICAMENTE un objeto JSON válido:
{
  "styleVibe": "Título corto y elegante del outfit recomendado",
  "stylistAdvice": "Consejo de 2 oraciones explicando por qué este look la favorece.",
  "imageGenerationPrompt": "Ultra-detailed full-length fashion editorial photography prompt showing an elegant woman with matching skin tone and physique wearing this perfect designer outfit, professional studio lighting, Vogue editorial aesthetic"
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
      if (parsed.imageGenerationPrompt) imagePrompt = parsed.imageGenerationPrompt;
    } catch (gErr) {
      console.warn('[AVISO] Error en análisis Gemini:', gErr.message);
    }

    // 3. Generar la imagen con Imagen 3 usando el endpoint oficial de Google
    console.log('[3/4] Generando imagen con Google Imagen 3...');
    const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:generateImages?key=${process.env.GEMINI_API_KEY}`;

    const imagenRes = await fetch(imagenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: imagePrompt,
        numberOfImages: 1,
        aspectRatio: '3:4',
        outputMimeType: 'image/jpeg'
      })
    });

    const rawResponse = await imagenRes.text();
    let imagenData = {};
    try {
      imagenData = JSON.parse(rawResponse);
    } catch (e) {
      console.error('[ERROR] Respuesta no JSON de Google:', rawResponse);
      throw new Error(`Google Imagen respondió con un formato inesperado: ${rawResponse.slice(0, 100)}`);
    }

    if (!imagenRes.ok) {
      console.error('[FAIL IMAGEN 3]', JSON.stringify(imagenData));
      const msg = imagenData.error?.message || `Error HTTP ${imagenRes.status}`;
      throw new Error(`Google Imagen 3: ${msg}`);
    }

    let outfitBase64 = null;
    if (imagenData.generatedImages?.[0]?.image?.imageBytes) {
      outfitBase64 = imagenData.generatedImages[0].image.imageBytes;
    } else {
      throw new Error('Google Imagen 3 respondió OK pero sin bytes de imagen.');
    }

    // 4. Subir la prenda creada a Cloudinary y generar URL con blur destructivo
    console.log('[4/4] Subiendo look generado a Cloudinary...');
    const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${outfitBase64}`, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_generated`
    });

    const blurredImageUrl = cloudinary.url(genUpload.public_id, {
      transformation: [
        { width: 600, height: 800, crop: 'fill' },
        { effect: 'blur:800', quality: 'auto:eco' }
      ],
      secure: true
    });

    // Guardar sesión para PayPal
    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: genUpload.public_id,
      styleVibe,
      stylistAdvice,
      paid: false,
      createdAt: new Date().toISOString()
    };

    console.log('[OK] Proceso terminado con éxito');

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
    console.error('[GLOBAL CATCH]', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Error interno del servidor.' })
    };
  }
};