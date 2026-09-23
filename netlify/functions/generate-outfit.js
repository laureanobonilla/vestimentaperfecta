// netlify/functions/generate-outfit.js
const { GoogleGenAI } = require('@google/genai');
const cloudinary = require('cloudinary').v2;
const { v4: uuidv4 } = require('uuid');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Inicializar el SDK forzando la versión compatible con API Keys de AI Studio
const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY,
  apiVersion: 'v1alpha'
});

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

    // 1. Guardar foto original en Cloudinary
    console.log('[STEP 1] Guardando foto original...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });

    // 2. Gemini 3.6 Flash analiza la foto y diseña el concepto
    console.log('[STEP 2] Analizando estilo con Gemini 3.6 Flash...');
    let styleVibe = "Alta Costura Contemporánea";
    let stylistAdvice = "Un corte estructurado y balance cromático ideal para tu presencia natural.";
    let imagePrompt = "Full-length fashion editorial photography of an elegant woman wearing a bespoke designer outfit matching natural skin tone, studio lighting, Vogue aesthetic, 8k";

    try {
      const geminiAnalysis = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Actúa como una estilista de moda femenina de lujo. Analiza a la persona en esta foto.
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
      console.log(`[STEP 2 OK] Concepto: "${styleVibe}"`);
    } catch (analysisErr) {
      console.error('[STEP 2 FAIL]', analysisErr);
      throw new Error(`Fallo en análisis de Gemini: ${analysisErr.message}`);
    }

    // 3. Generación de Imagen
    // Intentamos generar con Imagen a través del SDK con fallback al endpoint REST v1alpha
    console.log('[STEP 3] Generando imagen del outfit...');
    let outfitBase64 = null;

    try {
      // Método A: SDK nativo con apiVersion v1alpha
      const imageResult = await ai.models.generateImages({
        model: 'imagen-3.0-generate-002',
        prompt: imagePrompt,
        config: {
          numberOfImages: 1,
          aspectRatio: '3:4',
          outputMimeType: 'image/jpeg'
        }
      });

      if (imageResult?.generatedImages?.[0]?.image?.imageBytes) {
        outfitBase64 = imageResult.generatedImages[0].image.imageBytes;
      }
    } catch (sdkImgErr) {
      console.warn('[STEP 3 SDK AVISO] Fallo con SDK nativo:', sdkImgErr.message);

      // Método B: Llamada REST directa contra el endpoint v1alpha (no v1beta)
      const restEndpoint = `https://generativelanguage.googleapis.com/v1alpha/models/imagen-3.0-generate-002:generateImages?key=${process.env.GEMINI_API_KEY}`;
      const restRes = await fetch(restEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: imagePrompt,
          numberOfImages: 1,
          aspectRatio: '3:4',
          outputMimeType: 'image/jpeg'
        })
      });

      const restData = await restRes.json();
      if (restRes.ok && restData.generatedImages?.[0]?.image?.imageBytes) {
        outfitBase64 = restData.generatedImages[0].image.imageBytes;
      } else {
        console.error('[STEP 3 REST ERROR]', JSON.stringify(restData));
        throw new Error(restData.error?.message || sdkImgErr.message || 'No se pudo generar la imagen con Imagen 3.');
      }
    }

    // 4. Subir imagen generada a Cloudinary
    console.log('[STEP 4] Subiendo imagen generada a Cloudinary...');
    const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${outfitBase64}`, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_generated`
    });

    // 5. Generar URL de vista previa con desenfoque de servidor (blur:800)
    const blurredImageUrl = cloudinary.url(genUpload.public_id, {
      transformation: [
        { width: 600, height: 800, crop: 'fill' },
        { effect: 'blur:800', quality: 'auto:eco' }
      ],
      secure: true
    });

    // 6. Guardar sesión
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
    console.error('[CRITICAL ERROR]', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};