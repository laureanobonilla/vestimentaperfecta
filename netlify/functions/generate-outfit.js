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

    // --- PASO 1: Subir imagen original a Cloudinary ---
    console.log('[STEP 1] Subiendo original a Cloudinary...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });
    console.log(`[STEP 1 OK] Original guardado: ${originalUpload.public_id}`);

    // --- PASO 2: Gemini analiza y redacta el prompt de moda ---
    console.log('[STEP 2] Consultando Gemini para el estilismo...');
    let styleVibe = "Look Haute Couture Personalizado";
    let stylistAdvice = "Corte estructurado y balance de color ideal para realzar tu complexión.";
    let imagePrompt = "Full-body high-fashion editorial photography of an elegant woman wearing a bespoke luxury designer outfit matching natural skin tone, studio lighting, highly detailed 8k";

    try {
      const geminiAnalysis = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Actúa como una estilista de moda femenina de alta gama. Analiza a la persona en esta foto.
Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura:
{
  "styleVibe": "Título corto y elegante del outfit recomendado",
  "stylistAdvice": "Consejo personalizado de 2 oraciones explicando por qué este look la favorece.",
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
      console.log(`[STEP 2 OK] Prompt generado: "${imagePrompt}"`);
    } catch (analysisErr) {
      console.error('[STEP 2 FAIL] Error en Gemini:', analysisErr);
      throw new Error(`Fallo en análisis de Gemini: ${analysisErr.message}`);
    }

    // --- PASO 3: Generar imagen con Imagen 3 vía REST API de AI Studio ---
    console.log('[STEP 3] Llamando a Imagen 3 de Google AI Studio vía REST API...');
    const imagenEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${process.env.GEMINI_API_KEY}`;

    const imagenPayload = {
      instances: [
        { prompt: imagePrompt }
      ],
      parameters: {
        sampleCount: 1,
        aspectRatio: '3:4',
        outputMimeType: 'image/jpeg'
      }
    };

    const imagenRes = await fetch(imagenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(imagenPayload)
    });

    const imagenData = await imagenRes.json();

    if (!imagenRes.ok) {
      console.error('[STEP 3 ERROR REST]', JSON.stringify(imagenData));
      const msg = imagenData.error?.message || `HTTP Status ${imagenRes.status}`;
      throw new Error(`Error en Imagen 3 REST API: ${msg}`);
    }

    let outfitBase64 = null;
    if (imagenData.predictions?.[0]?.bytesBase64Encoded) {
      outfitBase64 = imagenData.predictions[0].bytesBase64Encoded;
    } else if (imagenData.predictions?.[0]?.imageBytes) {
      outfitBase64 = imagenData.predictions[0].imageBytes;
    } else {
      throw new Error('Imagen 3 respondió correctamente pero no incluyó bytes de imagen.');
    }

    console.log(`[STEP 3 OK] Imagen generada recibida con éxito (+${Date.now() - t0}ms)`);

    // --- PASO 4: Subir look generado a Cloudinary ---
    console.log('[STEP 4] Subiendo look generado a Cloudinary...');
    const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${outfitBase64}`, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_generated`
    });
    console.log(`[STEP 4 OK] Guardado con public_id: ${genUpload.public_id}`);

    // --- PASO 5: URL con desenfoque destructivo de Cloudinary ---
    const blurredImageUrl = cloudinary.url(genUpload.public_id, {
      transformation: [
        { width: 600, height: 800, crop: 'fill' },
        { effect: 'blur:800', quality: 'auto:eco' }
      ],
      secure: true
    });

    // --- PASO 6: Guardar sesión para PayPal ---
    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: genUpload.public_id,
      styleVibe,
      stylistAdvice,
      paid: false,
      createdAt: new Date().toISOString()
    };

    console.log(`[SUCCESS] Sesión completada en ${Date.now() - t0}ms`);

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
    console.error('[EXCEPTION]', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};