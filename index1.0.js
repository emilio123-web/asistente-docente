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
// CORRECCIÓN: Usando nombre de modelo válido y estable
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", 
    systemInstruction: `Eres un Asistente Académico Virtual diseñado para apoyar a los estudiantes cuando el docente no está disponible. Tu objetivo principal es facilitar el aprendizaje de forma amable, paciente y profesional.

Sigue estrictamente este protocolo de respuesta:
1. PRIORIDAD DE FUENTES: Ante cualquier duda, busca primero la respuesta en el material proporcionado por el docente (contexto del documento). Si la información es suficiente, basa tu respuesta exclusivamente en ella.
2. USO DE CONOCIMIENTO GENERAL: Si el material docente no contiene la respuesta o es insuficiente para que el alumno comprenda, utiliza tu base de datos interna para complementar la explicación, pero aclara que es información adicional de apoyo.
3. ESTRATEGIA PEDAGÓGICA: No te limites a dar la respuesta directa. Utiliza técnicas de enseñanza como:
   - Explicaciones paso a paso.
   - Analogías sencillas.
   - Preguntas socráticas para guiar al alumno a la solución.
4. TONO Y ESTILO: Mantén siempre un tono cortés, motivador y cercano. Si el alumno parece frustrado, ofrece una estrategia de enseñanza alternativa.
5. RESTRICCIONES: Si el alumno hace preguntas fuera del ámbito académico, redirígelo amablemente a los temas de la clase.`
});

// --- RUTAS API ---

// 1. Obtener todas las materias
app.get("/api/materias", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('docentes')
            .select('id, nombre, archivo_url');

        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Error al obtener materias." });
    }
});

// 2. Subir material (Docente) - CORREGIDO PARA NO BORRAR ANTERIOR
app.post("/api/docente/subir-material", async (req, res) => {
    const { materiaId, codigoAcceso, nombreDocente, textoAdicional } = req.body;
    
    if (!materiaId) return res.status(400).json({ error: "Falta ID de materia." });

    try {
        // A. BUSCAR CONTENIDO PREVIO PARA NO BORRARLO
        const { data: materiaExistente } = await supabase
            .from('docentes')
            .select('contenido')
            .eq('id', materiaId)
            .single();

        let contenidoAcumulado = materiaExistente?.contenido || "";
        let nuevoContenidoExtraido = textoAdicional || "";
        let urlPublica = null;

        // B. Procesar PDF si existe
        if (req.files && req.files.archivo) {
            const archivo = req.files.archivo;
            const dataPdf = await pdf(archivo.data);
            nuevoContenidoExtraido += `\n${dataPdf.text}`;

            const nombreArchivo = `${Date.now()}_${archivo.name.replace(/\s+/g, '_')}`;
            const { error: uploadError } = await supabase.storage
                .from('recursos-docentes')
                .upload(`archivos/${nombreArchivo}`, archivo.data, {
                    contentType: 'application/pdf',
                    upsert: true
                });

            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage
                .from('recursos-docentes')
                .getPublicUrl(`archivos/${nombreArchivo}`);
            
            urlPublica = publicUrlData.publicUrl;
        }

        // C. CONCATENAR: Viejo + Nuevo
        const contenidoFinal = (contenidoAcumulado + " " + nuevoContenidoExtraido).replace(/\s+/g, ' ').trim();

        // D. Guardar (Upsert)
        const { error: dbError } = await supabase
            .from('docentes')
            .upsert({ 
                id: materiaId,
                nombre: nombreDocente || materiaId,
                contenido: contenidoFinal,
                codigo: codigoAcceso,
                archivo_url: urlPublica // Actualiza a la última URL del archivo subido
            });

        if (dbError) throw dbError;

        res.json({ mensaje: "Material añadido exitosamente al acumulado." });

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: "Error al procesar material." });
    }
});

// 3. Preguntar a la IA (Alumno) - CORREGIDO
app.post("/api/alumno/preguntar", limitador, async (req, res) => {
    const { pregunta, materiaId, codigoAcceso } = req.body;

    try {
        const { data: materia, error } = await supabase
            .from('docentes')
            .select('*')
            .eq('id', materiaId)
            .single();
        
        if (error || !materia) return res.status(404).json({ respuesta: "Materia no encontrada." });
        
        if (codigoAcceso !== materia.codigo) {
            return res.status(403).json({ respuesta: "⚠️ Código incorrecto para esta materia." });
        }

        const contexto = materia.contenido;
        
        // PROMPT ESTRUCTURADO
        const promptFinal = `
            CONTEXTO DEL MATERIAL DOCENTE:
            """
            ${contexto}
            """

            PREGUNTA DEL ESTUDIANTE: 
            "${pregunta}"

            INSTRUCCIÓN ADICIONAL: Responde en español, usando Markdown para el formato.
        `;
        
        const result = await model.generateContent(promptFinal);
        const responseText = await result.response.text();
        
        res.json({ respuesta: responseText });

    } catch (error) {
        console.error("Error IA:", error);
        res.status(500).json({ respuesta: "Error al procesar tu duda en la IA." });
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
        res.json({ mensaje: "Materia eliminada." });
    } catch (error) {
        res.status(500).json({ error: "No se pudo eliminar." });
    }
});

// Manejo de Frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor activo en puerto ${PORT}`);
});