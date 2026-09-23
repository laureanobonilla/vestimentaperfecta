// netlify/functions/generate-outfit.js
const { GoogleGenAI } = require('@google/genai');
const { fal } = require('@fal-ai/client');
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
  console.log('[START] generate-outfit con pipeline completo de Fal.ai iniciado');

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { imageBase64 } = JSON.parse(event.body || '{}');
    if (!imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No se envió imagen.' }) };
    }

    const sessionId = uuidv4();
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    if (!process.env.FAL_KEY) {
      throw new Error('FAL_KEY no está configurada en las variables de entorno.');
    }
    fal.config({ credentials: process.env.FAL_KEY });

    // 1. Subir la foto original de la usuaria a Cloudinary
    console.log('[1/5] Subiendo foto original a Cloudinary...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });
    const userImageUrl = originalUpload.secure_url;

    // 2. Gemini analiza la complexión y diseña la prenda ideal
    console.log('[2/5] Gemini diseñando el concepto de alta costura...');
    let styleVibe = "Alta Costura Personalizada";
    let stylistAdvice = "Un diseño exclusivo que equilibra tu silueta y aporta una elegancia impecable.";
    let garmentPrompt = "A luxurious bespoke designer white evening dress, studio product photography, flat lay or ghost mannequin, clean background";

    try {
      const geminiAnalysis = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Actúa como director de estilismo. Devuelve ÚNICAMENTE un JSON válido:
{
  "styleVibe": "Título corto y elegante del outfit",
  "stylistAdvice": "Consejo de 2 oraciones.",
  "garmentPrompt": "Detailed English description of a stunning luxury designer garment (dress or suit) for a clean product photo on white background"
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
      if (parsed.garmentPrompt) garmentPrompt = parsed.garmentPrompt;
    } catch (gErr) {
      console.warn('Aviso en Gemini:', gErr.message);
    }

    // 3. Generar la foto de la prenda real usando FLUX en Fal.ai
    console.log('[3/5] Generando la prenda de alta costura con FLUX...');
    const garmentResult = await fal.subscribe("fal-ai/flux/schnell", {
      input: {
        prompt: garmentPrompt,
        image_size: "square_hd",
        num_inference_steps: 4
      }
    });

    const garmentImageUrl = garmentResult?.data?.images?.[0]?.url;
    if (!garmentImageUrl) {
      throw new Error("No se pudo generar la imagen de la prenda de ropa.");
    }
    console.log('[3/5 OK] Prenda generada:', garmentImageUrl);

    // 4. Aplicar Virtual Try-On combinando la foto de la usuaria y la prenda generada
    console.log('[4/5] Aplicando Virtual Try-On con IDM-VTON...');
    const tryOnResult = await fal.subscribe("fal-ai/idm-vton", {
      input: {
        human_image_url: userImageUrl,
        garment_image_url: garmentImageUrl,
        description: garmentPrompt,
        category: "auto"
      }
    });

    const finalGeneratedUrl = tryOnResult?.data?.image?.url;
    if (!finalGeneratedUrl) {
      throw new Error("El modelo de Virtual Try-On no devolvió el resultado final.");
    }
    console.log('[4/5 OK] Try-On completado:', finalGeneratedUrl);

    // 5. Descargar el resultado final y guardarlo en Cloudinary con desenfoque
    console.log('[5/5] Subiendo resultado protegido a Cloudinary...');
    const imgFetch = await fetch(finalGeneratedUrl);
    const imgBuffer = await imgFetch.arrayBuffer();
    
    const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${Buffer.from(imgBuffer).toString('base64')}`, {
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

    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: genUpload.public_id,
      styleVibe,
      stylistAdvice,
      paid: false,
      createdAt: new Date().toISOString()
    };

    console.log('[SUCCESS] Proceso completo de transformación finalizado.');

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
    console.error('[FATAL ERROR PIPELINE]:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Error en el pipeline de transformación.' })
    };
  }
};