import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

async function leerPDF() {
    try {
        const dataBuffer = fs.readFileSync('./Clase1.pdf');

        const data = await pdf(dataBuffer);

        console.log("✅ TEXTO EXTRAÍDO CON ÉXITO");
        console.log("--------------------------------");
        console.log(data.text.substring(0, 500));

    } catch (err) {
        console.error("❌ ERROR AL LEER EL PDF:", err);
    }
}

leerPDF();

