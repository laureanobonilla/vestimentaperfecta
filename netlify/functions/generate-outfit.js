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

    // 1. Guardar foto original en Cloudinary
    console.log('[STEP 1] Subiendo original a Cloudinary...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });
    console.log(`[STEP 1 OK] Guardado con id: ${originalUpload.public_id}`);

    // 2. Gemini 3.6 Flash analiza la foto y crea el prompt de diseño
    console.log('[STEP 2] Consultando Gemini para el estilismo...');
    let styleVibe = "Alta Costura Personalizada";
    let stylistAdvice = "Un corte estilizado que resalta tu armonía natural.";
    let imagePrompt = "Full-length fashion editorial photography of an elegant woman wearing a bespoke designer outfit matching skin tone, Vogue magazine photoshoot, studio lighting, 8k";

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
      console.log(`[STEP 2 OK] Prompt generado: "${imagePrompt}"`);
    } catch (analysisErr) {
      console.error('[STEP 2 FAIL] Error en Gemini:', analysisErr);
      throw new Error(`Fallo en análisis de Gemini: ${analysisErr.message}`);
    }

    // 3. Generar la imagen con Imagen 3 usando la API REST directa de Google AI Studio
    console.log('[STEP 3] Llamando a Imagen 3 REST API con API Key...');
    const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${process.env.GEMINI_API_KEY}`;
    
    const imagenResponse = await fetch(imagenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt: imagePrompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: '3:4',
          outputMimeType: 'image/jpeg'
        }
      })
    });

    const imagenData = await imagenResponse.json();

    if (!imagenResponse.ok) {
      console.error('[STEP 3 FAIL] Respuesta de error de Imagen 3:', JSON.stringify(imagenData));
      const errMsg = imagenData.error?.message || `HTTP ${imagenResponse.status}`;
      throw new Error(`Error en Imagen 3: ${errMsg}`);
    }

    let outfitBase64 = null;
    if (imagenData.predictions?.[0]?.bytesBase64Encoded) {
      outfitBase64 = imagenData.predictions[0].bytesBase64Encoded;
    } else if (imagenData.predictions?.[0]?.imageBytes) {
      outfitBase64 = imagenData.predictions[0].imageBytes;
    } else {
      throw new Error('Imagen 3 no devolvió datos binarios de imagen.');
    }

    console.log(`[STEP 3 OK] Imagen recibida con éxito (+${Date.now() - t0}ms)`);

    // 4. Subir la imagen generada a Cloudinary
    console.log('[STEP 4] Subiendo imagen generada a Cloudinary...');
    const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${outfitBase64}`, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_generated`
    });

    // 5. Generar la URL con desenfoque de servidor (blur:800)
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
    console.error('[ERROR]', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};