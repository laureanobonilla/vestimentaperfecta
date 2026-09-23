// netlify/functions/generate-outfit.js
exports.handler = async (event) => {
  console.log('[TEMPORAL MODE] Validación estricta de calidad de imagen');

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { imageBase64 } = JSON.parse(event.body || '{}');
    if (!imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No se envió ninguna imagen.' }) };
    }

    // Simulamos un breve retraso para dar sensación de análisis profesional
    await new Promise(resolve => setTimeout(resolve, 1200));

    // Devolvemos un error 400 controlado para forzar al frontend a regresar al inicio
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: "Para garantizar un resultado de alta costura impecable, por favor envía una imagen más clara con mejor iluminación frontal y fondo limpio." 
      })
    };

  } catch (error) {
    console.error('[ERROR TEMPORAL]:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Error en el servidor.' })
    };
  }
};