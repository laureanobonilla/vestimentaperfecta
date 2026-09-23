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
  console.log('[START] generate-outfit con Fal.ai REST API iniciado');

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

    if (!process.env.FAL_KEY) {
      throw new Error('FAL_KEY no está configurada en las variables de entorno.');
    }

    // 1. Subir la foto original de la usuaria a Cloudinary
    console.log('[1/4] Subiendo foto original a Cloudinary...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });
    const userImageUrl = originalUpload.secure_url;

    // 2. Gemini analiza la complexión y redacta la descripción del outfit
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
      console.warn('Aviso en análisis Gemini:', gErr.message);
    }

    // 3. Ejecutar Virtual Try-On en Fal.ai mediante petición REST directa
    console.log('[3/4] Enviando solicitud a Fal.ai IDM-VTON...');
    const falResponse = await fetch('https://fal.run/fal-ai/idm-vton', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${process.env.FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        human_image_url: userImageUrl,
        garment_image_url: "https://images.unsplash.com/photo-1515372039744-b8f02a3ae446",
        description: garmentDescription,
        category: "auto"
      })
    });

    const falData = await falResponse.json();

    if (!falResponse.ok || !falData.image?.url) {
      throw new Error(`Error en Fal.ai Try-On: ${falData.error || falResponse.statusText}`);
    }

    const generatedImageUrl = falData.image.url;
    console.log('[3/4 OK] Imagen generada por Fal.ai:', generatedImageUrl);

    // 4. Descargar el resultado final y guardarlo en Cloudinary con desenfoque
    console.log('[4/4] Subiendo resultado protegido a Cloudinary...');
    const imgFetch = await fetch(generatedImageUrl);
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

    console.log('[SUCCESS] Proceso completo finalizado con éxito.');

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