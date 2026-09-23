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
  console.log('[START] generate-outfit con Fal.ai IDM-VTON iniciado');

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

    // 1. Subir la foto original a Cloudinary para obtener una URL pública accesible
    console.log('[1/4] Subiendo foto original a Cloudinary...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });
    const userImageUrl = originalUpload.secure_url;

    // 2. Gemini analiza los detalles de moda y redacta la descripción del outfit
    console.log('[2/4] Gemini analizando complexión y diseñando el look...');
    let styleVibe = "Alta Costura Personalizada";
    let stylistAdvice = "Un diseño exclusivo que equilibra tu silueta y aporta una elegancia impecable.";
    let garmentDescription = "A luxurious bespoke designer evening dress, high-end editorial fashion";

    try {
      const geminiAnalysis = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Actúa como director de estilismo de alta moda. Analiza a la persona en esta foto.
Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta:
{
  "styleVibe": "Título corto y elegante del outfit recomendado",
  "stylistAdvice": "Consejo de 2 oraciones explicando por qué este look la favorece.",
  "garmentDescription": "Detailed English description of a stunning luxury designer outfit for virtual try-on"
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
      if (parsed.garmentDescription) garmentDescription = parsed.garmentDescription;
    } catch (gErr) {
      console.warn("Aviso en análisis Gemini:", gErr.message);
    }

    // 3. Llamada oficial al modelo de Virtual Try-On en Fal.ai (IDM-VTON)
    console.log('[3/4] Ejecutando Virtual Try-On en fal.ai/fal-ai/idm-vton...');
    
    // Configuramos la credencial con la variable de entorno FAL_KEY
    fal.config({ credentials: process.env.FAL_KEY });

    const result = await fal.subscribe("fal-ai/idm-vton", {
      input: {
        human_image_url: userImageUrl,
        // Usamos una prenda base de alta costura o generada por la descripción de Gemini
        garment_image_url: "https://images.unsplash.com/photo-1515372039744-b8f02a3ae446",
        description: garmentDescription,
        category: "auto"
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          console.log(`[FAL QUEUE] Progreso del Try-On...`);
        }
      },
    });

    if (!result?.data?.image?.url) {
      throw new Error("La API de Fal.ai no devolvió ninguna imagen generada.");
    }

    const generatedImageUrl = result.data.image.url;
    console.log('[3/4 SUCCESS] Imagen generada por Fal.ai:', generatedImageUrl);

    // 4. Descargar la imagen resultante y subirla a tus creaciones protegidas en Cloudinary
    const imgFetch = await fetch(generatedImageUrl);
    const imgBuffer = await imgFetch.arrayBuffer();
    
    const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${Buffer.from(imgBuffer).toString('base64')}`, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_generated`
    });

    // 5. Crear la vista previa con desenfoque destructivo en servidor (blur:800)
    const blurredImageUrl = cloudinary.url(genUpload.public_id, {
      transformation: [
        { width: 600, height: 800, crop: 'fill' },
        { effect: 'blur:800', quality: 'auto:eco' }
      ],
      secure: true
    });

    // 6. Registrar sesión para el pago de PayPal
    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: genUpload.public_id,
      styleVibe,
      stylistAdvice,
      paid: false,
      createdAt: new Date().toISOString()
    };

    console.log('[SUCCESS] Proceso completado con éxito.');

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
    console.error('[FATAL ERROR IN TRY-ON]:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Error en el proceso de vestimenta virtual.' })
    };
  }
};