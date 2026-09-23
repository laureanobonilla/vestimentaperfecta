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

    // 1. Guardar la foto original en Cloudinary
    await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });

    // 2. Gemini analiza la foto y crea el prompt de diseño de alta costura
    let styleVibe = "Alta Costura Personalizada";
    let stylistAdvice = "Un diseño impecable que equilibra las proporciones y realza tu tono natural.";
    let imagePrompt = "Full-length fashion editorial photography of an elegant woman wearing a bespoke luxury designer outfit matching natural skin tone, Vogue magazine photoshoot, studio lighting, 8k";

    try {
      const geminiAnalysis = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Analiza a la persona en esta foto con ojo de estilista de alta moda femenina. 
Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta:
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
    } catch (analysisErr) {
      console.error('Error en Gemini:', analysisErr);
    }

    // 3. Llamada directa por fetch al endpoint REST de Imagen 3 de Google AI Studio
    // Este es el mecanismo exacto que evita los bloqueos del SDK de Node.js
    const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${process.env.GEMINI_API_KEY}`;
    
    const response = await fetch(url, {
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

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Error en la API de Google Imagen (HTTP ${response.status})`);
    }

    const outfitBase64 = data.predictions?.[0]?.bytesBase64Encoded || data.predictions?.[0]?.imageBytes;
    if (!outfitBase64) {
      throw new Error('La API de Google no devolvió datos de imagen válidos.');
    }

    // 4. Subir la imagen generada por IA a Cloudinary
    const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${outfitBase64}`, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_generated`
    });

    // 5. Aplicar desenfoque seguro de servidor (blur:800)
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
    console.error('Error crítico en generate-outfit:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};