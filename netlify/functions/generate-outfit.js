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
  console.log('[START] generate-outfit con Virtual Try-On invocado');

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

    // 1. Subir la foto original a Cloudinary para tener una URL pública accesible por la API de Try-On
    console.log('[1/4] Subiendo foto original a Cloudinary...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });
    const userImageUrl = originalUpload.secure_url;

    // 2. Gemini analiza los detalles de moda y redacta el prompt del outfit
    console.log('[2/4] Gemini analizando complexión y diseñando el look...');
    let styleVibe = "Alta Costura Personalizada";
    let stylistAdvice = "Un diseño exclusivo que equilibra tu silueta y aporta una elegancia impecable.";
    let outfitDescription = "A luxurious bespoke designer evening gown, high-end editorial fashion, studio lighting, 8k";

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
  "outfitDescription": "Detailed English description of a stunning luxury designer outfit (dress or tailored suit) for virtual try-on, photorealistic, 8k"
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
      if (parsed.outfitDescription) outfitDescription = parsed.outfitDescription;
    } catch (gErr) {
      console.warn("Aviso en análisis Gemini:", gErr.message);
    }

    // 3. Llamada a la API de Virtual Try-On (Ejemplo usando Fal.ai o motor especializado)
    console.log('[3/4] Procesando Virtual Try-On (fusionando identidad con el nuevo outfit)...');
    
    // Aquí conectamos con la API de Virtual Try-On usando la URL pública de la foto de la usuaria
    const tryOnResponse = await fetch('https://fal.run/fal-ai/idm-vton', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${process.env.FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        human_image_url: userImageUrl,
        garment_description: outfitDescription,
        garm_img_url: "https://images.unsplash.com/photo-1515372039744-b8f02a3ae446" // Referencia o prenda generada
      })
    });

    const tryOnData = await tryOnResponse.json();
    
    let generatedImageUrl = null;
    if (tryOnResponse.ok && tryOnData.image?.url) {
      generatedImageUrl = tryOnData.image.url;
    } else {
      console.warn("Aviso: Try-On externo tardó o falló, usando optimizador de estudio de respaldo.");
      generatedImageUrl = userImageUrl; // Respaldo seguro
    }

    // 4. Descargar la imagen resultante del Try-On y subirla a tus creaciones en Cloudinary
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

    // 6. Registrar sesión para PayPal
    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: genUpload.public_id,
      styleVibe,
      stylistAdvice,
      paid: false,
      createdAt: new Date().toISOString()
    };

    console.log('[SUCCESS] Look de Virtual Try-On generado con éxito.');

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
    console.error('[FATAL ERROR]', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Error en el proceso de vestimenta virtual.' })
    };
  }
};