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
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { imageBase64 } = JSON.parse(event.body || '{}');
    if (!imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No se envió imagen' }) };
    }

    const sessionId = uuidv4();
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // 1. Guardar la foto original en Cloudinary (aura_outfits/originals)
    await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });

    // 2. Gemini analiza tono de piel, complexión y sugiere el outfit perfecto
    let styleVibe = "Chic Contemporáneo";
    let stylistAdvice = "Tonos neutros y corte sastre que favorecen tu armonía natural.";
    let fashionPrompt = "A fashionable woman wearing an elegant haute couture outfit, Vogue magazine photoshoot, studio lighting, highly detailed 8k";

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Analiza a la persona en esta foto como estilista de alta moda femenina.
Devuelve ÚNICAMENTE un JSON válido con este formato:
{
  "styleVibe": "Título corto y elegante del look (ej: Minimalismo Escandinavo en Tonos Lino)",
  "stylistAdvice": "Consejo personalizado de 2 frases explicando por qué este outfit favorece su tono y presencia.",
  "fashionPrompt": "Detailed prompt in english describing a professional fashion editorial model with similar physical appearance wearing this exact stunning designer outfit, full body, cinematic studio lighting, 8k resolution"
}`
              }
            ]
          }
        ],
        config: { responseMimeType: 'application/json' }
      });

      const parsed = JSON.parse(response.text);
      if (parsed.styleVibe) styleVibe = parsed.styleVibe;
      if (parsed.stylistAdvice) stylistAdvice = parsed.stylistAdvice;
      if (parsed.fashionPrompt) fashionPrompt = parsed.fashionPrompt;
    } catch (e) {
      console.warn("Fallo al analizar con Gemini:", e.message);
    }

    // 3. Generar la imagen del NUEVO look con el prompt de Gemini
    // Usamos el generador optimizado de moda (SDXL) vía URL
    const encodedPrompt = encodeURIComponent(fashionPrompt + ", full body fashion look, clean neutral background");
    const aiImageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=768&height=1024&nologo=true&seed=${Math.floor(Math.random() * 100000)}`;

    // 4. Subir la imagen generada por IA directamente a Cloudinary (aura_outfits/creations)
    const genUpload = await cloudinary.uploader.upload(aiImageUrl, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_generated`
    });

    // 5. Crear la vista previa borrosa sobre la imagen GENERADA
    const blurredImageUrl = cloudinary.url(genUpload.public_id, {
      transformation: [
        { width: 600, height: 800, crop: 'fill' },
        { effect: 'blur:800', quality: 'auto:eco' }
      ],
      secure: true
    });

    // 6. Guardar la sesión para PayPal
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
    console.error("Error en generate-outfit:", error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Error al procesar la propuesta de estilo.' })
    };
  }
};