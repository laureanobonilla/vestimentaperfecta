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
  console.log('[DEBUG START] ===== INICIO DE PETICIÓN GENERATE-OUTFIT =====');
  
  if (event.httpMethod !== 'POST') {
    console.log('[DEBUG ERROR] Método HTTP no permitido:', event.httpMethod);
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const rawBody = event.body || '{}';
    console.log('[DEBUG INFO] Longitud del body recibido:', rawBody.length);
    
    const parsedBody = JSON.parse(rawBody);
    const { imageBase64 } = parsedBody;

    if (!imageBase64) {
      console.log('[DEBUG ERROR] imageBase64 viene vacío o ausente.');
      return { statusCode: 400, body: JSON.stringify({ error: 'No se envió ninguna imagen.' }) };
    }

    const sessionId = uuidv4();
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    console.log(`[DEBUG INFO] ID de sesión asignado: ${sessionId}. Tamaño de imagen limpio: ${cleanBase64.length} caracteres.`);

    // --- PASO 1: Subir original a Cloudinary ---
    console.log('[DEBUG STEP 1] Intentando subir foto original a Cloudinary...');
    const originalUpload = await cloudinary.uploader.upload(`data:image/jpeg;base64,${cleanBase64}`, {
      folder: 'aura_outfits/originals',
      public_id: `${sessionId}_original`
    });
    console.log('[DEBUG STEP 1 SUCCESS] Original subido. URL pública:', originalUpload.secure_url);

    // --- PASO 2: Análisis exhaustivo con Gemini ---
    console.log('[DEBUG STEP 2] Preparando llamada a Gemini 2.0 Flash...');
    let styleVibe = "Alta Costura Personalizada";
    let stylistAdvice = "Un diseño impecable que realza tu silueta y elegancia natural.";

    try {
      console.log('[DEBUG STEP 2.1] Ejecutando ai.models.generateContent...');
      const geminiResponse = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
              {
                text: `Actúa como directora de estilismo de alta moda. Analiza a la persona en esta foto.
Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta:
{
  "styleVibe": "Título corto y elegante del outfit recomendado",
  "stylistAdvice": "Consejo personalizado de 3 oraciones explicando el concepto de moda y por qué la favorece."
}`
              }
            ]
          }
        ],
        config: { responseMimeType: 'application/json' }
      });

      console.log('[DEBUG STEP 2.2 SUCCESS] Respuesta cruda de Gemini recibida:', geminiResponse.text);
      
      const parsed = JSON.parse(geminiResponse.text);
      console.log('[DEBUG STEP 2.3 JSON PARSED] Objeto parseado con éxito:', parsed);

      if (parsed.styleVibe) styleVibe = parsed.styleVibe;
      if (parsed.stylistAdvice) stylistAdvice = parsed.stylistAdvice;
      
    } catch (geminiErr) {
      console.error('[DEBUG STEP 2 ERROR CRITICAL] Falló la llamada o el parseo de Gemini:', geminiErr);
      console.error('[DEBUG STEP 2 ERROR STACK]:', geminiErr.stack);
      // Dejamos los valores por defecto para que no se muera la app, pero queda registrado en Netlify Logs
    }

    // --- PASO 3: Procesamiento visual en Cloudinary ---
    console.log('[DEBUG STEP 3] Aplicando transformaciones de estudio en Cloudinary...');
    const editorialUrl = cloudinary.url(originalUpload.public_id, {
      transformation: [
        { width: 800, height: 1066, crop: 'fill', gravity: 'face' },
        { effect: 'improve', quality: 'auto:best' },
        { effect: 'contrast:15', vibrance: 15 }
      ],
      secure: true
    });
    console.log('[DEBUG STEP 3.1] URL editorial generada:', editorialUrl);

    const editorialUpload = await cloudinary.uploader.upload(editorialUrl, {
      folder: 'aura_outfits/creations',
      public_id: `${sessionId}_editorial`
    });
    console.log('[DEBUG STEP 3 SUCCESS] Versión editorial subida con ID:', editorialUpload.public_id);

    // --- PASO 4: Generación de blur ---
    console.log('[DEBUG STEP 4] Generando vista previa con desenfoque destructivo...');
    const blurredImageUrl = cloudinary.url(editorialUpload.public_id, {
      transformation: [
        { effect: 'blur:900', quality: 'auto:eco' }
      ],
      secure: true
    });
    console.log('[DEBUG STEP 4 SUCCESS] URL blurred generada:', blurredImageUrl);

    // --- PASO 5: Guardar sesión ---
    global.sessionsDb[sessionId] = {
      sessionId,
      publicId: editorialUpload.public_id,
      styleVibe,
      stylistAdvice,
      paid: false,
      createdAt: new Date().toISOString()
    };
    console.log('[DEBUG STEP 5 SUCCESS] Sesión guardada en memoria temporal.');

    console.log('[DEBUG END] ===== PETICIÓN COMPLETADA CON ÉXITO =====');
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
    console.error('[DEBUG FATAL EXCEPTION EN HANDLER]:', error);
    console.error('[DEBUG FATAL STACK]:', error.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Error interno crítico del servidor.' })
    };
  }
};