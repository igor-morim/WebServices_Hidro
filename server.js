const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 🔧 CONFIGURAÇÃO DO TIPO DE CONEXÃO
const TIPO = 2; // 1 = Local, 2 = Remoto (Google Drive)

// Configurações para modo remoto
const API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyBPSNDxno-Zp2TsPr3nzxIWhIj24iIo6c0';
const DRIVE_FILE_ID = '1D-CpAm3fBswjbdiJfIvKoCgF3ZfSESzu';
const TEMP_DIR = path.join(__dirname, 'temp');

// Criar pasta temporária se não existir (para modo remoto)
if (TIPO === 2 && !fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 📊 CONEXÃO COM BANCO DE DADOS LOCAL
let db;

if (TIPO === 1) {
    // MODO LOCAL
    const dbPath = path.join(__dirname, 'database', 'BD_SIMA_MA.db');
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('❌ Erro ao conectar com banco LOCAL:', err.message);
        } else {
            console.log('✅ Conectado ao banco SQLite LOCAL');
        }
    });
} else {
    // MODO REMOTO - Conexão será feita sob demanda
    console.log('🔗 Modo REMOTO ativado - Conexões serão feitas via Google Drive API');
}

// 🔄 SISTEMA DE CACHE PARA MODO REMOTO
let databaseCache = {
    data: null,
    lastDownload: null,
    fileSize: 0
};

const CACHE_DURATION = 10 * 60 * 1000; // 10 minutos

// 🔄 FUNÇÃO DE DOWNLOAD SIMPLIFICADA (igual ao código que funciona)
async function downloadDatabaseFromDrive() {
    // Verificar cache apenas para modo remoto
    if (TIPO === 2 && databaseCache.data && databaseCache.lastDownload && 
        (Date.now() - databaseCache.lastDownload) < CACHE_DURATION) {
        console.log('♻️ Usando cache do banco');
        return databaseCache.data;
    }

    return new Promise((resolve, reject) => {
        const tempFileName = `BD_cache_${Date.now()}.db`;
        const destPath = path.join(TEMP_DIR, tempFileName);
        
        console.log('📥 Baixando banco do Google Drive...');
        
        const url = `https://www.googleapis.com/drive/v3/files/${DRIVE_FILE_ID}?alt=media&key=${API_KEY}`;
        
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Erro HTTP ${response.statusCode}: ${response.statusMessage}`));
                return;
            }
            
            const fileStream = fs.createWriteStream(destPath);
            let downloadedBytes = 0;
            
            response.on('data', (chunk) => {
                downloadedBytes += chunk.length;
            });
            
            response.pipe(fileStream);
            
            fileStream.on('finish', () => {
                fileStream.close();
                console.log(`✅ Banco baixado! ${(downloadedBytes / 1024 / 1024).toFixed(2)} MB`);
                
                // Atualizar cache apenas para modo remoto
                if (TIPO === 2) {
                    databaseCache = {
                        data: destPath,
                        lastDownload: Date.now(),
                        fileSize: downloadedBytes
                    };
                    
                    cleanupOldCacheFiles();
                }
                
                resolve(destPath);
            });
            
            fileStream.on('error', (error) => {
                if (fs.existsSync(destPath)) {
                    fs.unlinkSync(destPath);
                }
                reject(error);
            });
            
        }).on('error', (error) => {
            reject(error);
        });
    });
}

// 🧹 LIMPEZA DE ARQUIVOS ANTIGOS (apenas para modo remoto)
function cleanupOldCacheFiles() {
    if (TIPO !== 2) return;
    
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        const MAX_AGE = 20 * 60 * 1000; // 20 minutos
        
        files.forEach(file => {
            if (file.startsWith('BD_cache_')) {
                const filePath = path.join(TEMP_DIR, file);
                try {
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtime.getTime() > MAX_AGE && filePath !== databaseCache.data) {
                        fs.unlinkSync(filePath);
                        console.log(`🧹 Limpou cache antigo: ${file}`);
                    }
                } catch (error) {
                    console.log(`⚠️ Não pôde limpar: ${file}`);
                }
            }
        });
    } catch (error) {
        console.log('ℹ️ Nenhum arquivo para limpar');
    }
}

// 🔄 FUNÇÃO PARA EXECUTAR QUERIES REMOTAS
async function executeRemoteQuery(query, params = []) {
    let dbPath;
    let tempDb;
    
    try {
        dbPath = await downloadDatabaseFromDrive();
        tempDb = new sqlite3.Database(dbPath);
        
        return new Promise((resolve, reject) => {
            tempDb.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
    } catch (error) {
        throw error;
    } finally {
        if (tempDb) {
            tempDb.close();
        }
        // NÃO remove o arquivo - fica em cache para próxima requisição
    }
}

// 🔄 FUNÇÃO UNIFICADA PARA EXECUTAR QUERIES
function executeQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        if (TIPO === 1) {
            // MODO LOCAL
            db.all(query, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        } else {
            // MODO REMOTO
            executeRemoteQuery(query, params)
                .then(resolve)
                .catch(reject);
        }
    });
}

// 📊 ROTAS DA API:

// Rota de status
app.get('/api/status', async (req, res) => {
    try {
        await executeQuery('SELECT 1 as status');
        
        const statusInfo = {
            message: "success",
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO (Google Drive)",
            status: "Conectado",
            timestamp: new Date().toISOString()
        };
        
        // Adicionar info de cache se for modo remoto
        if (TIPO === 2) {
            statusInfo.cache = {
                hasCache: !!databaseCache.data,
                lastDownload: databaseCache.lastDownload ? new Date(databaseCache.lastDownload).toISOString() : null,
                fileSize: databaseCache.fileSize ? `${(databaseCache.fileSize / 1024 / 1024).toFixed(2)} MB` : '0 MB'
            };
        }
        
        res.json(statusInfo);
    } catch (error) {
        res.status(500).json({
            error: error.message,
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO (Google Drive)"
        });
    }
});

// 1. Listar todas as estações
app.get('/api/estacoes', async (req, res) => {
    try {
        const sql = `
            SELECT 
                codigo_origin as codigo,
                estacao as nome,
                municipio,
                rio,
                bacia,
                latitude,
                longitude
            FROM cadastro_estacoes 
            ORDER BY rio, estacao
        `;
        
        const rows = await executeQuery(sql);
        res.json({
            message: "success",
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO",
            data: rows
        });
    } catch (error) {
        res.status(400).json({ 
            error: error.message,
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO"
        });
    }
});

// 2. Dados de uma estação específica
app.get('/api/estacao/:codigo', async (req, res) => {
    try {
        const codigo = req.params.codigo;
        
        const sql = `
            SELECT 
                data_completa as data,
                nivel,
                vazao,
                precipitacao
            FROM dados_diarios 
            WHERE codigo_estacao = ?
            ORDER BY data_completa DESC
            LIMIT 100
        `;
        
        const rows = await executeQuery(sql, [codigo]);
        res.json({
            message: "success",
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO",
            data: rows
        });
    } catch (error) {
        res.status(400).json({ 
            error: error.message,
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO"
        });
    }
});

// 3. Dados para gráfico (últimos 7 dias)
app.get('/api/grafico/:codigo', async (req, res) => {
    try {
        const codigo = req.params.codigo;
        
        const sql = `
            SELECT 
                date(data_completa) as data,
                AVG(nivel) as nivel_medio,
                AVG(vazao) as vazao_media,
                SUM(precipitacao) as chuva_acumulada
            FROM dados_diarios 
            WHERE codigo_estacao = ? 
              AND date(data_completa) >= date('now', '-7 days')
            GROUP BY date(data_completa)
            ORDER BY data
        `;
        
        const rows = await executeQuery(sql, [codigo]);
        res.json({
            message: "success",
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO",
            data: rows
        });
    } catch (error) {
        res.status(400).json({ 
            error: error.message,
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO"
        });
    }
});

// 4. Dados em tempo real (últimas 24h)
app.get('/api/tempo-real/:codigo', async (req, res) => {
    try {
        const codigo = req.params.codigo;
        
        const sql = `
            SELECT 
                data_completa as data,
                nivel,
                vazao,
                precipitacao
            FROM dados_diarios 
            WHERE codigo_estacao = ? 
              AND datetime(data_completa) >= datetime('now', '-1 day')
            ORDER BY data_completa DESC
        `;
        
        const rows = await executeQuery(sql, [codigo]);
        res.json({
            message: "success",
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO",
            data: rows
        });
    } catch (error) {
        res.status(400).json({ 
            error: error.message,
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO"
        });
    }
});

// 5. Dados com filtro por data
app.get('/api/dados-filtrados/:codigo', async (req, res) => {
    try {
        const codigo = req.params.codigo;
        const { dataInicio, dataFim } = req.query;
        
        let sql = `
            SELECT 
                data_completa as data,
                nivel,
                vazao,
                precipitacao
            FROM dados_diarios 
            WHERE codigo_estacao = ?
        `;
        
        const params = [codigo];
        
        // Adicionar filtros de data se fornecidos
        if (dataInicio && dataFim) {
            sql += ` AND date(data_completa) BETWEEN ? AND ?`;
            params.push(dataInicio, dataFim);
        }
        
        sql += ` ORDER BY data_completa DESC`;
        
        const rows = await executeQuery(sql, params);
        res.json({
            message: "success",
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO",
            data: rows
        });
    } catch (error) {
        res.status(400).json({ 
            error: error.message,
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO"
        });
    }
});

// 6. Datas disponíveis para uma estação
app.get('/api/datas-disponiveis/:codigo', async (req, res) => {
    try {
        const codigo = req.params.codigo;
        
        const sql = `
            SELECT 
                MIN(date(data_completa)) as data_minima,
                MAX(date(data_completa)) as data_maxima
            FROM dados_diarios 
            WHERE codigo_estacao = ?
        `;
        
        const rows = await executeQuery(sql, [codigo]);
        res.json({
            message: "success",
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO",
            data: rows[0] || {}
        });
    } catch (error) {
        res.status(400).json({ 
            error: error.message,
            tipo: TIPO === 1 ? "LOCAL" : "REMOTO"
        });
    }
});

// 7. Limpar cache manualmente (apenas modo remoto)
app.post('/api/clear-cache', (req, res) => {
    if (TIPO === 2) {
        databaseCache = {
            data: null,
            lastDownload: null,
            fileSize: 0
        };
        cleanupOldCacheFiles();
        console.log('🧹 Cache limpo manualmente via API');
        res.json({ 
            message: 'Cache limpo com sucesso',
            tipo: 'REMOTO',
            timestamp: new Date().toISOString()
        });
    } else {
        res.json({ 
            message: 'Modo local - cache não aplicável',
            tipo: 'LOCAL'
        });
    }
});

// REMOVER A ROTA PROBLEMÁTICA DE DOWNLOAD
// (Manter apenas as rotas essenciais)

// Rota raiz
app.get('/', (req, res) => {
    res.json({
        message: '🚀 API SIMA MA - Render + Google Drive',
        endpoints: {
            status: '/api/status',
            estacoes: '/api/estacoes',
            estacao: '/api/estacao/:codigo',
            grafico: '/api/grafico/:codigo',
            tempoReal: '/api/tempo-real/:codigo',
            dadosFiltrados: '/api/dados-filtrados/:codigo',
            datasDisponiveis: '/api/datas-disponiveis/:codigo',
            clearCache: '/api/clear-cache (POST)'
        }
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`🔧 Modo: ${TIPO === 1 ? 'LOCAL' : 'REMOTO (Google Drive API)'}`);
    if (TIPO === 2) {
        console.log(`💾 Sistema de cache ativado (10 minutos)`);
        console.log(`🔗 Google Drive File ID: ${DRIVE_FILE_ID}`);
    }
});