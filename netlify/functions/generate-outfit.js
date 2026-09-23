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

    // 1. Guardar la original para tus registros
    await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });

    // 2. Gemini diseña el concepto de moda exacto
    let styleVibe = "Minimalismo de Lujo en Tonos Neutros";
    let stylistAdvice = "Un conjunto sofisticado con bléiser estructurado y pantalones de corte sastre que realza tu presencia ejecutiva.";
    let fashionPrompt = "High-end fashion editorial photography of a gorgeous professional model wearing a luxury designer haute couture outfit, clean studio background, Vogue magazine style, 8k resolution";

    try {
      const geminiAnalysis = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Analiza la estructura corporal y presencia en esta foto. 
Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura:
{
  "styleVibe": "Título sofisticado del outfit perfecto para ella",
  "stylistAdvice": "Consejo de 2 oraciones explicando por qué este diseño la favorece.",
  "fashionPrompt": "Detailed english description of a professional fashion model wearing a stunning custom luxury designer outfit tailored for her silhouette, high-end studio lighting, editorial vogue aesthetic, 8k"
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
      if (parsed.fashionPrompt) fashionPrompt = parsed.fashionPrompt;
    } catch (gErr) {
      console.warn("Aviso en Gemini:", gErr.message);
    }

    // 3. Generar la imagen real del outfit mediante motor gráfico de alta calidad
    const encodedPrompt = encodeURIComponent(fashionPrompt + ", high quality fashion photography, 8k, photorealistic");
    const aiImageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=768&height=1024&nologo=true&seed=${Math.floor(Math.random() * 999999)}`;

    // Descargar la imagen generada por IA y subirla a tu Cloudinary
    const imgFetch = await fetch(aiImageUrl);
    const imgBuffer = await imgFetch.arrayBuffer();
    const outfitBase64 = Buffer.from(imgBuffer).toString('base64');

    const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${outfitBase64}`, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_generated`
    });

    // 4. Crear la vista previa con desenfoque de servidor destructivo (blur:800)
    const blurredImageUrl = cloudinary.url(genUpload.public_id, {
      transformation: [
        { width: 600, height: 800, crop: 'fill' },
        { effect: 'blur:800', quality: 'auto:eco' }
      ],
      secure: true
    });

    // 5. Guardar sesión para el cobro en PayPal
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
    console.error(error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Error al procesar el look.' })
    };
  }
};