import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

// 1. Cargar variables de entorno
dotenv.config();

// 2. Configurar la API (Asegúrate que en tu .env diga API_KEY=tu_llave)
const genAI = new GoogleGenerativeAI(process.env.API_KEY);

async function run() {
  try {
    // 3. Llamada al método listModels
    const response = await genAI.listModels();
    
    console.log("=== MODELOS DISPONIBLES EN TU CUENTA ===");
    
    response.models.forEach((model) => {
      // Filtramos para ver solo los que permiten generar contenido
      if (model.supportedGenerationMethods.includes("generateContent")) {
        console.log(`> ID: ${model.name}`);
        console.log(`  Descripción: ${model.description}`);
        console.log("---------------------------------------");
      }
    });

  } catch (error) {
    console.error("Error detallado:");
    console.error(error);
  }
}

run();