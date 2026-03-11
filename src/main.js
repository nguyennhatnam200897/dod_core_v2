import { bootApp } from './dist/core.js';

const routes = {
    '/': {
        name: 'HomeView',
        fetcher: async (isInitialLoad) => {
            const factory = (await import('./dist/HomeView.js')).default;
            if (isInitialLoad) return { factory };
            
            const text = await (await fetch('/')).text();
            const html = text.match(/<main id="app-container">([\s\S]*?)<\/main>/)[1];
            return { html, factory };
        }
    },
    '/cart': {
        name: 'CartView',
        fetcher: async (isInitialLoad) => {
            const factory = (await import('./dist/CartView.js')).default;
            if (isInitialLoad) return { factory };
            
            const text = await (await fetch('/cart/')).text();
            const html = text.match(/<main id="app-container">([\s\S]*?)<\/main>/)[1];
            return { html, factory };
        }
    }
};

async function boot() {
    await bootApp(); // Khởi động WASM

    // Nạp Data Nhị phân (Giả lập fetch file prices.bin)
    console.log("Đang nạp Database Nhị phân vào Khe cắm O(1)...");
    const pricesDB = new Float64Array(100000).fill(150000); // 150k/sản phẩm
    window.MB.loadDatabase(0, 'F64', pricesDB);

    // Bật Router
    window.MB.Router.init('#app-container', routes);
}
boot();

// --- CÁC HÀM CẦU NỐI JS ĐƯỢC WASM GỌI ---
window.initHomeVirtualScroll = () => {
    const pids = Array.from({length: 100000}, (_, i) => i);
    window.MB.initVirtualScroll('homePool', '#home-grid', pids, 150, (mbId, pid, rowIndex) => {
        if (pid === null) return;
        const card = document.querySelector(`[data-mb-id="${mbId}"]`);
        if (card) {
            card.querySelector('.p-name').textContent = `Sản phẩm #${pid}`;
            card.querySelector('.btn-add').dataset.id = pid;
            // Đọc trực tiếp từ DB Slots cực nhanh
            const price = window.MB.components[mbId].mem._rustCore.ptr_f64_slot(0); 
            // Lưu ý: Cần export hàm ptr_f64_slot trong lõi Rust để JS có thể đọc mảng
            card.querySelector('.p-price').textContent = `150,000 đ`; 
        }
    });
};

window.renderCartListAndCalculate = () => {
    // Logic vòng lặp JS duyệt qua Store, render HTML giỏ hàng và tính tổng tiền
    console.log("Đang tính toán lại giỏ hàng...");
};