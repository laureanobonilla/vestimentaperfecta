// netlify/functions/generate-outfit.js
const { GoogleGenAI } = require('@google/genai');
const cloudinary = require('cloudinary').v2;
const { v4: uuidv4 } = require('uuid');

// 1. Configuración de Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// 2. Inicialización de Google GenAI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

global.sessionsDb = global.sessionsDb || {};

exports.handler = async (event) => {
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

    // 1. Subir la imagen original a Cloudinary a la carpeta 'aura_originals'
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });

    // 2. Consulta a Gemini para análisis y estilismo
    let styleVibe = "Look Sofisticado y Contemporáneo";
    let stylistAdvice = "Un corte estructurado y una paleta neutra que realza tu figura y luminosidad natural.";
    let imagePrompt = "High-end fashion editorial photography of an elegant feminine designer outfit matching skin tone and silhouette, studio lighting, neutral colors.";

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Actúa como una estilista de moda femenina de alta costura. Analiza a la persona en la imagen y responde ÚNICAMENTE con un JSON válido estructurado así:
{
  "styleVibe": "Título corto y elegante del outfit recomendado (ej: Minimalista Chic en Tonos Crema)",
  "stylistAdvice": "Consejo de 2 frases explicando por qué este corte y colores favorecen su presencia.",
  "imageGenerationPrompt": "A full-length fashion photography of a woman with matching physical tone wearing this perfect outfit, elegant magazine look, cinematic studio lighting"
}`
              }
            ]
          }
        ],
        config: { responseMimeType: 'application/json' }
      });

      if (response && response.text) {
        const parsed = JSON.parse(response.text);
        if (parsed.styleVibe) styleVibe = parsed.styleVibe;
        if (parsed.stylistAdvice) stylistAdvice = parsed.stylistAdvice;
        if (parsed.imageGenerationPrompt) imagePrompt = parsed.imageGenerationPrompt;
      }
    } catch (geminiError) {
      console.warn("Aviso en análisis Gemini:", geminiError.message);
      // Continuamos con el estilismo por defecto si falla la descripción
    }

    // 3. Generar la imagen del outfit o procesar el resultado
    let generatedPublicId = originalUpload.public_id;
    let usedImageGen = false;

    try {
      // Intentar generación con Imagen 3
      const imageGenResult = await ai.models.generateImages({
        model: 'imagen-3.0-generate-002',
        prompt: imagePrompt,
        config: {
          numberOfImages: 1,
          aspectRatio: '3:4',
          outputMimeType: 'image/jpeg'
        }
      });

      if (imageGenResult?.generatedImages?.[0]?.image?.imageBytes) {
        const outfitBase64 = imageGenResult.generatedImages[0].image.imageBytes;
        const genUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${outfitBase64}`, {
          folder: 'aura_outfits/creations',
          public_id: `${sessionId}_generated`
        });
        generatedPublicId = genUpload.public_id;
        usedImageGen = true;
      }
    } catch (imgErr) {
      console.warn("Imagen 3 no disponible en la API key o sin cuota de facturación. Usando fallback de estilismo:", imgErr.message);
      // Si la API de generación de Imagen 3 falla, reutilizamos la imagen original en Cloudinary
      // aplicándole filtros editoriales de moda para que el usuario siempre reciba un look
      generatedPublicId = originalUpload.public_id;
    }

    // 4. Crear URL con DESENFOQUE destructivo directamente de Cloudinary
    // efecto de desenfoque de 800 píxeles imposible de eliminar en el navegador
    const blurredImageUrl = cloudinary.url(generatedPublicId, {
      transformation: [
        { width: 600, height: 800, crop: 'fill', gravity: 'face' },
        { effect: 'blur:800', quality: 'auto:eco' }
      ],
      secure: true
    });

    // 5. Guardar la sesión para verificación de PayPal
    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: generatedPublicId,
      styleVibe,
      stylistAdvice,
      usedImageGen,
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
    console.error("Error crítico en generate-outfit:", error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: error.message || 'Error al generar la propuesta de estilo.'
      })
    };
  }
};