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
  console.log('[DEBUG START] ----------------------------------------');
  
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

    // 1. Validar entorno
    if (!process.env.FAL_KEY) {
      console.error('[FATAL ERROR] FAL_KEY no está configurada en las variables de entorno de Netlify.');
      throw new Error('FAL_KEY falta en las variables de entorno del servidor.');
    }

    // 2. Subir original a Cloudinary
    console.log('[STEP 1] Subiendo foto original a Cloudinary...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });
    const userImageUrl = originalUpload.secure_url;
    console.log('[STEP 1 OK] URL pública original:', userImageUrl);

    // 3. Gemini analiza la imagen
    console.log('[STEP 2] Consultando Gemini para la descripción del outfit...');
    let styleVibe = "Alta Costura Personalizada";
    let stylistAdvice = "Un diseño exclusivo que equilibra tu silueta.";
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
                text: `Actúa como director de estilismo. Devuelve ÚNICAMENTE un JSON válido:
{
  "styleVibe": "Título corto y elegante del outfit",
  "stylistAdvice": "Consejo de 2 oraciones.",
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
      console.log('[STEP 2 OK] Descripción generada:', garmentDescription);
    } catch (gErr) {
      console.error('[STEP 2 WARN] Error en Gemini, usando valores por defecto:', gErr.message);
    }

    // 4. Llamada a Fal.ai con manejo estricto de errores
    console.log('[STEP 3] Iniciando suscripción a fal-ai/idm-vton...');
    fal.config({ credentials: process.env.FAL_KEY });

    let generatedImageUrl = null;
    try {
      const result = await fal.subscribe("fal-ai/idm-vton", {
        input: {
          human_image_url: userImageUrl,
          garment_image_url: "https://images.unsplash.com/photo-1515372039744-b8f02a3ae446",
          description: garmentDescription,
          category: "auto"
        },
        logs: true,
        onQueueUpdate: (update) => {
          console.log(`[FAL QUEUE STATUS]: ${update.status}`);
        },
      });

      console.log('[STEP 3 RAW RESULT]:', JSON.stringify(result));

      if (result?.data?.image?.url) {
        generatedImageUrl = result.data.image.url;
      } else {
        throw new Error('La respuesta de Fal.ai no contiene la URL de la imagen en data.image.url');
      }
    } catch (falInnerErr) {
      console.error('[STEP 3 FAL ERROR EXPLICITO]:', falInnerErr.message);
      if (falInnerErr.body) console.error('[STEP 3 FAL BODY]:', JSON.stringify(falInnerErr.body));
      throw new Error(`Fallo en Fal.ai Try-On: ${falInnerErr.message}`);
    }

    console.log('[STEP 3 OK] URL de imagen generada por IA:', generatedImageUrl);

    // 5. Descargar y subir a Cloudinary creaciones
    console.log('[STEP 4] Descargando imagen resultante y subiendo a Cloudinary...');
    const imgFetch = await fetch(generatedImageUrl);
    if (!imgFetch.ok) throw new Error(`No se pudo descargar la imagen desde Fal.ai (HTTP ${imgFetch.status})`);
    
    const imgBuffer = await imgFetch.arrayBuffer();
    const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${Buffer.from(imgBuffer).toString('base64')}`, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_generated`
    });

    // 6. Crear URL con desenfoque destructivo
    const blurredImageUrl = cloudinary.url(genUpload.public_id, {
      transformation: [
        { width: 600, height: 800, crop: 'fill' },
        { effect: 'blur:800', quality: 'auto:eco' }
      ],
      secure: true
    });

    // 7. Guardar sesión
    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: genUpload.public_id,
      styleVibe,
      stylistAdvice,
      paid: false,
      createdAt: new Date().toISOString()
    };

    console.log('[DEBUG END] Proceso completado con éxito.');
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
    console.error('[DEBUG FATAL CATCH EN HANDLER]:', error.message);
    console.error('[DEBUG STACK TRACE]:', error.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Error en servidor: ${error.message}` })
    };
  }
};