import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { GoogleGenerativeAI } from "@google/generative-ai";

// --- LA SOLUCIÓN AQUÍ ---
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse'); 
// ------------------------

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURACIÓN DE IA ---
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", // Nota: Verifica que usas una versión válida (ej. 1.5-flash)
    systemInstruction: "Eres el Asistente Virtual de la cátedra. Solo respondes basándote en la información oficial del docente. Si el alumno pregunta algo que NO está en el material, responde que no tienes esa información y deben esperar al profesor. No busques en internet."
});

// Memoria volátil (se borra si reinicias el servidor)
let baseDeConocimientos = "Aún no hay material cargado por el docente.";

// Configuración de Multer para archivos
const upload = multer({ storage: multer.memoryStorage() });


// 1. Subir texto simple
app.post("/docente/subir-texto", (req, res) => {
    const { contenido } = req.body;
    if (!contenido) return res.status(400).json({ error: "Falta el contenido" });
    
    baseDeConocimientos += `\n${contenido}`; 
    res.json({ mensaje: "Texto añadido a la base de conocimientos." });
});

// 2. Subir PDF y extraer texto
// Busca tu ruta de subir-pdf y asegúrate de que se vea así:
app.post("/docente/subir-pdf", upload.single("archivo"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No hay archivo." });

        const data = await pdf(req.file.buffer); 

        baseDeConocimientos += `\n${data.text}`;

        res.json({ mensaje: "PDF procesado y guardado con éxito." });
    } catch (error) {
        console.error("DETALLE DEL ERROR:", error);
        res.status(500).json({ error: "Error al leer el PDF." });
    }
});
// 3. Consulta del alumno
app.post("/alumno/preguntar", async (req, res) => {
    const { pregunta } = req.body;
    if (!pregunta) return res.status(400).json({ error: "Falta la pregunta" });

    try {
        const promptFinal = `
            MATERIAL DE CÁTEDRA (CONTEXTO):
            ${baseDeConocimientos}

            PREGUNTA DEL ALUMNO:
            ${pregunta}
        `;
        
        const result = await model.generateContent(promptFinal);
        res.json({ respuesta: result.response.text() });
    } catch (error) {
        console.error(error);
        res.status(500).json("Error al procesar con la IA.");
    }
});

app.listen(port, () => {
    console.log(`🚀 Servidor listo en http://localhost:${port}`);
});