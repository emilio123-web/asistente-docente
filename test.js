const enviarPregunta = async () => {
  try {
    const response = await fetch('http://localhost:3000/preguntar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pregunta: 'tu nombre ?' })
    });

    const data = await response.json();
    console.log("🤖 Respuesta de la IA:", data.respuesta);
  } catch (error) {
    console.error("❌ Error al conectar:", error.message);
  }
};

enviarPregunta();