import 'dotenv/config';
import express from 'express';
import fileUpload from 'express-fileupload';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { rateLimit } from 'express-rate-limit';
import { createRequire } from 'module';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

const app = express();

// --- CONFIGURACIÓN SUPABASE ---
// Asegúrate de tener estas variables en el .env de Render
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- LIMITADOR ---
const limitador = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { respuesta: "Demasiadas peticiones. Intenta en 15 min." }
});

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(fileUpload());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURACIÓN DE IA ---
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    systemInstruction: `Eres un Asistente Docente Virtual empático y pedagógico. 
    Tu función es responder preguntas de alumnos basándote EXCLUSIVAMENTE en el material proporcionado. 
    Si la respuesta no está en el material, indícalo cortésmente.`
});

// --- RUTAS API ---

// 1. Obtener todas las materias (Desde Supabase)
app.get("/api/materias", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('docentes')
            .select('id, nombre, archivo_url');

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Error al obtener materias de Supabase." });
    }
});

// 2. Subir material (Docente)
app.post("/api/docente/subir-material", async (req, res) => {
    const { materiaId, codigoAcceso, nombreDocente, textoAdicional } = req.body;
    
    if (!materiaId) return res.status(400).json({ error: "Falta ID de materia." });

    try {
        let contenidoExtraido = textoAdicional || "";
        let urlPublica = null;

        // Procesar PDF si existe
        if (req.files && req.files.archivo) {
            const archivo = req.files.archivo;
            
            // Extraer texto para la IA
            const dataPdf = await pdf(archivo.data);
            contenidoExtraido += `\n${dataPdf.text}`;

            // Subir archivo a Supabase Storage
            const nombreArchivo = `${Date.now()}_${archivo.name.replace(/\s+/g, '_')}`;
            const { data: uploadData, error: uploadError } = await supabase.storage
                .from('recursos-docentes')
                .upload(`archivos/${nombreArchivo}`, archivo.data, {
                    contentType: 'application/pdf',
                    upsert: true
                });

            if (uploadError) throw uploadError;

            // Obtener URL Pública
            const { data: publicUrlData } = supabase.storage
                .from('recursos-docentes')
                .getPublicUrl(`archivos/${nombreArchivo}`);
            
            urlPublica = publicUrlData.publicUrl;
        }

        const contenidoLimpio = contenidoExtraido.replace(/\s+/g, ' ').trim();

        // GUARDAR EN TABLA "docentes" DE SUPABASE
        const { error: dbError } = await supabase
            .from('docentes')
            .upsert({ 
                id: materiaId, // Asegúrate que en Supabase 'id' sea TEXT si usas nombres, o genera un UUID
                nombre: nombreDocente || materiaId,
                contenido: contenidoLimpio,
                codigo: codigoAcceso,
                archivo_url: urlPublica
            });

        if (dbError) throw dbError;

        res.json({ 
            mensaje: `Material guardado correctamente`, 
            url: urlPublica 
        });

    } catch (error) {
        console.error("Error detallado:", error);
        res.status(500).json({ error: "Error al procesar y guardar el material." });
    }
});

// 3. Preguntar a la IA (Alumno)
app.post("/api/alumno/preguntar", limitador, async (req, res) => {
    const { pregunta, materiaId, codigoAcceso } = req.body;

    try {
        // Buscar materia en Supabase
        const { data: materia, error } = await supabase
            .from('docentes')
            .select('*')
            .eq('id', materiaId)
            .single();
        
        if (error || !materia) return res.status(404).json({ respuesta: "Materia no encontrada." });
        
        // Verificar código de acceso
        if (codigoAcceso !== materia.codigo) {
            return res.status(403).json({ respuesta: "⚠️ Código incorrecto para esta materia." });
        }

        const contexto = materia.contenido;
        const hoy = new Date().toLocaleDateString('es-ES');
        
        // Prompt optimizado
        const promptFinal = `
            FECHA ACTUAL: ${hoy}
            CONTEXTO DEL DOCENTE: ${contexto}
            
            PREGUNTA DEL ESTUDIANTE: ${pregunta}
            
            INSTRUCCIÓN: Responde de forma clara usando el contexto arriba. Si no sabes la respuesta, sugiere contactar al docente.
        `;
        
        const result = await model.generateContent(promptFinal);
        res.json({ respuesta: result.response.text() });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error en la consulta de IA." });
    }
});

// 4. Borrar Materia
app.delete("/api/docente/borrar-materia/:id", async (req, res) => {
    try {
        const { error } = await supabase
            .from('docentes')
            .delete()
            .eq('id', req.params.id);

        if (error) throw error;
        res.json({ mensaje: "Materia eliminada de Supabase." });
    } catch (error) {
        res.status(500).json({ error: "No se pudo eliminar." });
    }
});

// Manejo de Frontend (SPA)
app.use((req, res) => {
    if (!req.url.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});