// netlify/functions/generate-outfit.js
const { GoogleGenAI } = require('@google/genai');
const cloudinary = require('cloudinary').v2;
const { v4: uuidv4 } = require('uuid');

// Configura Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Simulador en memoria/almacenamiento temporal para sesiones
// En producción usa Supabase, FaunaDB o Netlify Blobs
global.sessionsDb = global.sessionsDb || {};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { imageBase64 } = JSON.parse(event.body);
    if (!imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No image provided' }) };
    }

    const sessionId = uuidv4();
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // 1. Gemini analiza la foto, estima la edad y crea el concepto del outfit
    const analysisResponse = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
            {
              text: `Analiza a la persona en esta foto con ojo de estilista de moda femenina de alta gama.
Devuelve ÚNICAMENTE un objeto JSON válido con este formato:
{
  "estimatedAgeRange": "18-24" | "25-34" | "35-44" | "45-54" | "55+",
  "styleVibe": "breve descripción del estilo sugerido (ej: Chic parisino en tonos tierra)",
  "stylistAdvice": "Consejo personalizado de 2 frases explicando por qué este outfit favorece su complexión.",
  "imageGenerationPrompt": "Ultra detailed fashion photography prompt showing a woman with matching physical characteristics wearing the perfect flattering designer outfit, studio lighting, Vogue editorial aesthetic."
}`
            }
          ]
        }
      ],
      generationConfig: { responseMimeType: 'application/json' }
    });

    const parsedData = JSON.parse(analysisResponse.text);

    // 2. Generar el Outfit con Imagen 3 a través de Google GenAI
    const imageGenResult = await ai.models.generateImages({
      model: 'imagen-3.0-generate-002',
      prompt: parsedData.imageGenerationPrompt,
      config: {
        numberOfImages: 1,
        aspectRatio: '3:4',
        outputMimeType: 'image/jpeg'
      }
    });

    const generatedImageBase64 = imageGenResult.generatedImages[0].image.imageBytes;

    // 3. Subir a Cloudinary con auto-expiración de 24h
    const uploadRes = await cloudinary.uploader.upload(`data:image/jpeg;base64,${generatedImageBase64}`, {
      folder: 'aura_outfits',
      public_id: sessionId,
      tags: ['outfit_temp', `age_${parsedData.estimatedAgeRange}`]
    });

    // 4. Crear URL con desenfoque directo de servidor (imposible de burlar con CSS)
    // Cloudinary aplica blur óptico e_blur:900 directo en la imagen servida
    const blurredUrl = cloudinary.url(uploadRes.public_id, {
      transformation: [
        { effect: 'blur:900', quality: 'auto:low' }
      ],
      secure: true
    });

    // Guardar temporalmente el registro con la métrica de edad
    global.sessionsDb[sessionId] = {
      sessionId,
      estimatedAge: parsedData.estimatedAgeRange,
      styleAdvice: parsedData.stylistAdvice,
      hdPublicId: uploadRes.public_id,
      paid: false,
      createdAt: new Date().toISOString()
    };

    console.log(`[Métrica Demográfica]: Nueva foto procesada. Rango de edad estimado: ${parsedData.estimatedAgeRange}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        blurredImageUrl: blurredUrl,
        styleSnippet: parsedData.styleVibe
      })
    };

  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error al generar la propuesta de estilo.' })
    };
  }
};