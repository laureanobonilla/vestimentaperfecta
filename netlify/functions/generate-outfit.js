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
  console.log(`[START] generate-outfit con Imagen 3 - ${new Date().toISOString()}`);

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const { imageBase64 } = JSON.parse(event.body || '{}');
    if (!imageBase64) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No se envió ninguna imagen.' })
      };
    }

    const sessionId = uuidv4();
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // 1. Guardar la foto original de la usuaria en Cloudinary
    await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });

    // 2. Gemini analiza la foto y crea el prompt exacto del outfit
    let styleVibe = "Alta Costura Personalizada";
    let stylistAdvice = "Un diseño creado para realzar tu complexión y elegancia natural.";
    let imagePrompt = "Full-length fashion editorial photography of an elegant woman wearing a luxury designer outfit matching natural skin tone, studio lighting, Vogue magazine photoshoot, 8k";

    try {
      const geminiAnalysis = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Analiza a la persona en esta foto con ojo de estilista de alta costura femenina. 
Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta:
{
  "styleVibe": "Título corto y elegante del outfit recomendado (ej: Sastrería Chic en Tonos Tierra)",
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
    } catch (analysisErr) {
      console.warn('Aviso en análisis Gemini:', analysisErr.message);
    }

    // 3. Generar la imagen del NUEVO OUTFIT con Google Imagen 3 vía REST direct (Compatible 100% con Cloud/AI Studio)
    console.log('[IAMGEN 3] Generando nuevo look con IA...');
    const imagenEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${process.env.GEMINI_API_KEY}`;

    let outfitBase64 = null;
    try {
      const imagenRes = await fetch(imagenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt: imagePrompt }],
          parameters: { sampleCount: 1, aspectRatio: '3:4', outputMimeType: 'image/jpeg' }
        })
      });

      const imagenData = await imagenRes.json();
      if (imagenRes.ok && (imagenData.predictions?.[0]?.bytesBase64Encoded || imagenData.predictions?.[0]?.imageBytes)) {
        outfitBase64 = imagenData.predictions[0].bytesBase64Encoded || imagenData.predictions[0].imageBytes;
      }
    } catch (restErr) {
      console.warn("Fallo en endpoint REST de Imagen 3, usando generador alternativo de alta gama:", restErr.message);
    }

    // Si por alguna razón la API de Google de imágenes requiere el SDK de Vertex, usamos el generador de respaldo de alta fidelidad
    if (!outfitBase64) {
      const encodedPrompt = encodeURIComponent(imagePrompt + ", fashion catalog editorial, 8k resolution");
      const fallbackRes = await fetch(`https://image.pollinations.ai/prompt/${encodedPrompt}?width=768&height=1024&nologo=true&model=flux`);
      const buffer = await fallbackRes.arrayBuffer();
      outfitBase64 = Buffer.from(buffer).toString('base64');
    }

    // 4. Subir la imagen del outfit generado a Cloudinary
    const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${outfitBase64}`, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_generated`
    });

    // 5. Crear la vista previa borrosa directamente en el servidor de Cloudinary (blur:800)
    const blurredImageUrl = cloudinary.url(genUpload.public_id, {
      transformation: [
        { width: 600, height: 800, crop: 'fill' },
        { effect: 'blur:800', quality: 'auto:eco' }
      ],
      secure: true
    });

    // 6. Guardar la sesión para validar el pago de PayPal
    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: genUpload.public_id,
      styleVibe,
      stylistAdvice,
      paid: false,
      createdAt: new Date().toISOString()
    };

    console.log(`[SUCCESS] Look generado y protegido en ${Date.now() - t0}ms`);

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
      body: JSON.stringify({ error: error.message || 'Error interno al generar el look.' })
    };
  }
};