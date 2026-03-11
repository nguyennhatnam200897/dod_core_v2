import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildApp } from '../engine/framework_v44.js';
import { HomeView } from './views/HomeView.js';
import { CartView } from './views/CartView.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../public');
const templatesDir = path.join(__dirname, 'templates');

// 1. BIÊN DỊCH LOGIC SANG C++/WASM VÀ JS CHUNKS
buildApp([HomeView, CartView], path.join(publicDir, 'dist'));

// 2. LẮP RÁP HTML (SSG)
const layoutHTML = fs.readFileSync(path.join(templatesDir, 'layout.html'), 'utf-8');

const pages = [
    { route: '/', dir: publicDir, title: 'Trang chủ | DOD', tpl: 'home.html' },
    { route: '/cart', dir: path.join(publicDir, 'cart'), title: 'Giỏ hàng | DOD', tpl: 'cart.html' }
];

console.log("🔨 Đang lắp ráp SSG chuẩn SEO...");
pages.forEach(page => {
    if (!fs.existsSync(page.dir)) fs.mkdirSync(page.dir, { recursive: true });
    
    const content = fs.readFileSync(path.join(templatesDir, page.tpl), 'utf-8');
    const finalHTML = layoutHTML
        .replace('{{TITLE}}', page.title)
        .replace('{{META_DESC}}', 'Enterprise E-commerce')
        .replace('{{PAGE_CONTENT}}', content);
        
    fs.writeFileSync(path.join(page.dir, 'index.html'), finalHTML);
    console.log(`✅ [SSG] Đã đúc: ${page.route}`);
});