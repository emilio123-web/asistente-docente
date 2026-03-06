import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from "@google/generative-ai";
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { rateLimit } from 'express-rate-limit';
import { createRequire } from 'module';

// --- CONFIGURACIÓN DE RUTAS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

const app = express();

// --- LIMITADOR ---
const limitador = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100, // Aumentado para pruebas
    message: { respuesta: "Demasiadas peticiones. Intenta en 15 min." }
});

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Servir archivos estáticos de la carpeta public
app.use(express.static(path.join(__dirname, 'public')));

// --- BASE DE DATOS ---
let db;
(async () => {
    try {
        db = await open({
            filename: path.join(__dirname, 'database.sqlite'), 
            driver: sqlite3.Database
        });
        await db.exec(`
            CREATE TABLE IF NOT EXISTS materias (
                id TEXT PRIMARY KEY,
                contenido TEXT
            )
        `);
        console.log("✅ Base de datos SQLite lista.");
    } catch (error) {
        console.error("❌ Error en DB:", error);
    }
})();

// --- CONFIGURACIÓN DE IA ---
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", // Corregido a versión estable
    systemInstruction: `Eres un Asistente Docente Virtual empático y pedagógico.
    REGLAS: 1. Usa el MATERIAL DE CÁTEDRA. 2. Usa ejemplos y analogías. 3. Verifica fechas.`
});

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 } 
});

// --- RUTAS API ---

app.get("/api/materias", async (req, res) => {
    try {
        const materias = await db.all("SELECT id FROM materias");
        res.json(materias.map(m => ({ materiaId: m.id })));
    } catch (error) {
        res.status(500).json({ error: "Error al obtener materias." });
    }
});

app.post("/api/docente/subir-material", upload.single("archivo"), async (req, res) => {
    const { materiaId, textoAdicional } = req.body;
    if (!materiaId) return res.status(400).json({ error: "Falta ID de materia." });

    try {
        let contenidoExtraido = textoAdicional || "";
        if (req.file) {
            const data = await pdf(req.file.buffer);
            contenidoExtraido += `\n${data.text}`;
        }
        const contenidoLimpio = contenidoExtraido.replace(/\s+/g, ' ').trim();
        const materiaExistente = await db.get("SELECT contenido FROM materias WHERE id = ?", [materiaId]);
        const nuevoContenido = materiaExistente ? materiaExistente.contenido + "\n" + contenidoLimpio : contenidoLimpio;

        await db.run("INSERT OR REPLACE INTO materias (id, contenido) VALUES (?, ?)", [materiaId, nuevoContenido]);
        res.json({ mensaje: `Material actualizado para: ${materiaId}` });
    } catch (error) {
        res.status(500).json({ error: "Error al procesar material." });
    }
});

app.post("/api/alumno/preguntar", limitador, async (req, res) => {
    const { pregunta, materiaId, codigoAcceso } = req.body;
    const MI_CLAVE_DOCENTE = "favaloro"; 

    if (codigoAcceso !== MI_CLAVE_DOCENTE) {
        return res.status(403).json({ respuesta: "⚠️ Código incorrecto." });
    }

    try {
        const materia = await db.get("SELECT contenido FROM materias WHERE id = ?", [materiaId]);
        const contexto = materia ? materia.contenido : "No hay material.";
        const hoy = new Date().toLocaleDateString('es-ES');

        const promptFinal = `FECHA: ${hoy}\nCONTEXTO: ${contexto}\nPREGUNTA: ${pregunta}`;
        const result = await model.generateContent(promptFinal);
        res.json({ respuesta: result.response.text() });
    } catch (error) {
        res.status(500).json({ error: "Error en la IA." });
    }
});

app.delete("/api/docente/borrar-materia/:id", async (req, res) => {
    await db.run("DELETE FROM materias WHERE id = ?", [req.params.id]);
    res.json({ mensaje: "Eliminado." });
});

// --- SOLUCIÓN AL ERROR DE PATH-TO-REGEXP ---
// En lugar de app.get('*'), usamos un middleware que captura todo lo que no sea API
app.use((req, res) => {
    if (!req.url.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// --- INICIO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});