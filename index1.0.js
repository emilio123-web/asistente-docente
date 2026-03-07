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
// 2. Subir material (Docente) - CONFIGURADO PARA ACUMULACIÓN TOTAL
app.post("/api/docente/subir-material", async (req, res) => {
    const { materiaId, codigoAcceso, nombreDocente, textoAdicional } = req.body;
    
    if (!materiaId) return res.status(400).json({ error: "Falta ID de materia." });

    try {
        // 1. OBTENER DATOS ACTUALES (Texto y URLs previas)
        const { data: materiaExistente } = await supabase
            .from('docentes')
            .select('contenido, archivo_url')
            .eq('id', materiaId)
            .single();

        let contenidoAcumulado = materiaExistente?.contenido || "";
        let listaUrlsAnteriores = materiaExistente?.archivo_url || ""; // Asumiendo que es un string o lista
        let nuevoTextoExtraido = textoAdicional || "";
        let urlDelNuevoArchivo = null;

        // 2. PROCESAR EL NUEVO PDF
        if (req.files && req.files.archivo) {
            const archivo = req.files.archivo;
            
            // Extraer texto para la IA
            const dataPdf = await pdf(archivo.data);
            nuevoTextoExtraido += `\n${dataPdf.text}`;

            // CREAR NOMBRE ÚNICO (Evita que el PDF nuevo borre al viejo en Storage)
            const timestamp = Date.now();
            const nombreLimpio = archivo.name.replace(/\s+/g, '_');
            const nombreFinalStorage = `archivos/${materiaId}/${timestamp}_${nombreLimpio}`;

            const { error: uploadError } = await supabase.storage
                .from('recursos-docentes')
                .upload(nombreFinalStorage, archivo.data, {
                    contentType: 'application/pdf',
                    upsert: false // No sobrescribir nunca
                });

            if (uploadError) throw uploadError;

            // Obtener la URL del nuevo archivo
            const { data: publicUrlData } = supabase.storage
                .from('recursos-docentes')
                .getPublicUrl(nombreFinalStorage);
            
            urlDelNuevoArchivo = publicUrlData.publicUrl;
        }

        // 3. CONCATENAR TEXTO Y ACTUALIZAR LISTA DE URLS
        const contenidoFinal = (contenidoAcumulado + " " + nuevoTextoExtraido).replace(/\s+/g, ' ').trim();
        
        // Creamos una lista separada por comas o saltos de línea para las URLs
        const todasLasUrls = listaUrlsAnteriores 
            ? `${listaUrlsAnteriores}\n${urlDelNuevoArchivo}` 
            : urlDelNuevoArchivo;

        // 4. GUARDAR CAMBIOS (UPSERT)
        const { error: dbError } = await supabase
            .from('docentes')
            .upsert({ 
                id: materiaId,
                nombre: nombreDocente || materiaId,
                contenido: contenidoFinal, // Aquí se suma el texto de los 15 PDFs
                codigo: codigoAcceso,
                archivo_url: todasLasUrls // Aquí se guardan todos los links
            });

        if (dbError) throw dbError;

        res.json({ 
            mensaje: "Material sumado con éxito. El asistente ahora es más inteligente.",
            urls: todasLasUrls 
        });

    } catch (error) {
        console.error("Error al acumular material:", error);
        res.status(500).json({ error: "Error al procesar y sumar el material." });
    }
});


// NUEVA RUTA: BORRAR UN RECURSO ESPECÍFICO
// ============================================================
app.post("/api/docente/borrar-recurso", async (req, res) => {
    const { materiaId, urlABorrar, codigoAcceso } = req.body;

    if (!materiaId || !urlABorrar) {
        return res.status(400).json({ error: "Faltan datos para eliminar el archivo." });
    }

    try {
        // 1. Verificar que la materia existe y el código es correcto
        const { data: materia, error: searchError } = await supabase
            .from('docentes')
            .select('*')
            .eq('id', materiaId)
            .single();

        if (searchError || !materia) return res.status(404).json({ error: "Materia no encontrada." });
        if (codigoAcceso !== materia.codigo) return res.status(403).json({ error: "Código incorrecto." });

        // 2. Limpiar la lista de URLs
        // Convertimos el string de la DB en un array, quitamos la URL elegida y volvemos a unir
        const urlsActuales = materia.archivo_url ? materia.archivo_url.split('\n') : [];
        const urlsFiltradas = urlsActuales.filter(url => url.trim() !== urlABorrar.trim() && url.trim() !== "");
        const nuevasUrlsString = urlsFiltradas.join('\n');

        // 3. Borrar el archivo físico del Storage de Supabase
        // Extraemos la ruta interna: "archivos/ID/nombre.pdf"
        const parteRuta = urlABorrar.split('/storage/v1/object/public/recursos-docentes/')[1];
        if (parteRuta) {
            await supabase.storage
                .from('recursos-docentes')
                .remove([parteRuta]);
        }

        // 4. Actualizar la base de datos con la nueva lista de URLs
        // IMPORTANTE: El texto en 'materia.contenido' seguirá ahí. 
        // Para borrar el texto exacto necesitarías una base de datos más compleja,
        // por ahora esto limpia la lista de archivos visuales.
        const { error: updateError } = await supabase
            .from('docentes')
            .update({ archivo_url: nuevasUrlsString })
            .eq('id', materiaId);

        if (updateError) throw updateError;

        res.json({ 
            mensaje: "Archivo eliminado del registro.", 
            urlsRestantes: nuevasUrlsString 
        });

    } catch (error) {
        console.error("Error al borrar recurso:", error);
        res.status(500).json({ error: "No se pudo eliminar el archivo." });
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