// netlify/functions/generate-outfit.js
const { GoogleGenAI } = require('@google/genai');
const cloudinary = require('cloudinary').v2;
const { v4: uuidv4 } = require('uuid');

// 1. Verificación de variables de entorno críticas
const requiredEnv = [
  'GEMINI_API_KEY',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET'
];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`[CONFIG ERROR] Variables faltantes en Netlify: ${missingEnv.join(', ')}`);
}

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

  if (missingEnv.length > 0) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: `Faltan variables en Netlify: ${missingEnv.join(', ')}`,
        step: 'ENV_VERIFICATION'
      })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { imageBase64 } = body;

    if (!imageBase64) {
      console.warn('[VALIDATION ERROR] No se recibió imageBase64 en el cuerpo de la petición.');
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No se envió ninguna imagen.', step: 'INPUT_VALIDATION' })
      };
    }

    const sessionId = uuidv4();
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    console.log(`[INFO] Sesión ${sessionId} creada. Tamaño Base64: ${Math.round(cleanBase64.length / 1024)} KB`);

    // --- PASO 1: Subir original a Cloudinary ---
    console.log('[STEP 1] Subiendo imagen original a Cloudinary...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });
    console.log(`[STEP 1 OK] Original almacenado con public_id: ${originalUpload.public_id} (+${Date.now() - t0}ms)`);

    // --- PASO 2: Análisis con Gemini ---
    console.log('[STEP 2] Enviando imagen a Gemini para diseño del look...');
    let styleVibe = "Look Haute Couture Personalizado";
    let stylistAdvice = "Corte estructurado y balance de color ideal para realzar tu complexión.";
    let imagePrompt = "Full-body high-fashion editorial photography of an elegant woman wearing a bespoke luxury designer outfit matching natural skin tone, studio lighting, highly detailed 8k";

    try {
      const geminiAnalysis = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
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

      console.log(`[STEP 2 OK] Respuesta de Gemini recibida (+${Date.now() - t0}ms)`);
      const parsed = JSON.parse(geminiAnalysis.text);
      if (parsed.styleVibe) styleVibe = parsed.styleVibe;
      if (parsed.stylistAdvice) stylistAdvice = parsed.stylistAdvice;
      if (parsed.imageGenerationPrompt) imagePrompt = parsed.imageGenerationPrompt;
      console.log(`[STEP 2 DATA] Prompt generado: "${imagePrompt}"`);
    } catch (analysisErr) {
      console.error('[STEP 2 FAIL] Error durante el análisis de Gemini:', analysisErr);
      throw new Error(`Fallo en análisis de Gemini: ${analysisErr.message}`);
    }

    // --- PASO 3: Generación de imagen con Imagen 3 (SIN FALLBACKS OCULTOS) ---
    console.log('[STEP 3] Ejecutando ai.models.generateImages con imagen-3.0-generate-002...');
    let outfitBase64 = null;

    try {
      const imageResult = await ai.models.generateImages({
        model: 'imagen-3.0-generate-002',
        prompt: imagePrompt,
        config: {
          numberOfImages: 1,
          aspectRatio: '3:4',
          outputMimeType: 'image/jpeg'
        }
      });

      console.log('[STEP 3 RAW RESPONSE]', JSON.stringify({
        hasGeneratedImages: !!imageResult?.generatedImages,
        count: imageResult?.generatedImages?.length || 0
      }));

      if (imageResult?.generatedImages?.[0]?.image?.imageBytes) {
        outfitBase64 = imageResult.generatedImages[0].image.imageBytes;
        console.log(`[STEP 3 OK] Imagen recibida de Imagen 3 (+${Date.now() - t0}ms)`);
      } else {
        throw new Error('La API de Imagen 3 no devolvió bytes de imagen en el payload.');
      }
    } catch (imgError) {
      console.error('[STEP 3 CRITICAL FAIL] Error de generación en Imagen 3:', imgError);
      // Extraer datos útiles del error de Google
      const status = imgError.status || imgError.statusCode || 'N/A';
      const details = imgError.errorDetails || imgError.message || 'Error desconocido';
      throw new Error(`Fallo en Imagen 3 (Status ${status}): ${details}`);
    }

    // --- PASO 4: Subir el outfit generado por Gemini a Cloudinary ---
    console.log('[STEP 4] Subiendo imagen generada por IA a Cloudinary...');
    const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${outfitBase64}`, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_generated`
    });
    console.log(`[STEP 4 OK] Look generado guardado con public_id: ${genUpload.public_id} (+${Date.now() - t0}ms)`);

    // --- PASO 5: Crear URL con desenfoque destructivo de servidor ---
    const blurredImageUrl = cloudinary.url(genUpload.public_id, {
      transformation: [
        { width: 600, height: 800, crop: 'fill' },
        { effect: 'blur:800', quality: 'auto:eco' }
      ],
      secure: true
    });

    // --- PASO 6: Persistir datos de la sesión ---
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
    console.error(`[EXCEPTION] Fin con error (+${Date.now() - t0}ms):`, error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: error.message || 'Error desconocido al procesar la imagen.',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })
    };
  }
};