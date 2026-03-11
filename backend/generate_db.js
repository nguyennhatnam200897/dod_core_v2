const fs = require('fs');
const path = require('path');

// 1. CẤU HÌNH QUY MÔ DỮ LIỆU
const TOTAL_PRODUCTS = 100000;  // 100 ngàn sản phẩm
const TOTAL_HASHTAGS = 10000;   // 10 ngàn hashtag khác nhau

console.log(`🚀 Bắt đầu sinh Database cho ${TOTAL_PRODUCTS} sản phẩm...`);
console.time("⏱️ Tổng thời gian xử lý");

// 2. KHỞI TẠO CHỈ MỤC ĐẢO NGƯỢC (Mảng 2 chiều tạm thời)
// Index: Hashtag ID -> Value: Mảng các Product ID chứa hashtag đó
const invertedIndex = Array.from({ length: TOTAL_HASHTAGS }, () => []);

// 3. MÔ PHỎNG DỮ LIỆU: Gắn random Hashtag cho Sản phẩm
for (let pId = 0; pId < TOTAL_PRODUCTS; pId++) {
    // Mỗi sản phẩm có ngẫu nhiên từ 5 đến 15 hashtag
    const numTags = Math.floor(Math.random() * 11) + 5; 
    
    // Dùng Set để đảm bảo 1 sản phẩm không bị gắn trùng 1 hashtag 2 lần
    const uniqueTags = new Set();
    while (uniqueTags.size < numTags) {
        const randomTagId = Math.floor(Math.random() * TOTAL_HASHTAGS);
        uniqueTags.add(randomTagId);
    }

    // Nạp ID sản phẩm (pId) vào các giỏ Hashtag tương ứng
    uniqueTags.forEach(tagId => {
        invertedIndex[tagId].push(pId);
    });
}

// 4. TRẢI PHẲNG DỮ LIỆU (DATA-ORIENTED DESIGN)
// Đếm tổng số lượng mối quan hệ để cấp phát RAM chuẩn xác
let totalRelations = 0;
for (let i = 0; i < TOTAL_HASHTAGS; i++) {
    totalRelations += invertedIndex[i].length;
}

// Khởi tạo 3 Khe cắm (Slots) dưới dạng TypedArray (Bộ nhớ phẳng)
const tag_starts = new Int32Array(TOTAL_HASHTAGS);
const tag_lengths = new Int32Array(TOTAL_HASHTAGS);
const tag_product_ids = new Int32Array(totalRelations);

// Đổ dữ liệu từ mảng 2 chiều xuống mảng phẳng tuyến tính
let currentCursor = 0;
for (let tagId = 0; tagId < TOTAL_HASHTAGS; tagId++) {
    const pids = invertedIndex[tagId];
    
    tag_starts[tagId] = currentCursor;
    tag_lengths[tagId] = pids.length;
    
    // Chép các Product ID vào mảng khổng lồ
    for (let j = 0; j < pids.length; j++) {
        tag_product_ids[currentCursor] = pids[j];
        currentCursor++;
    }
}

// 5. XUẤT RA FILE NHỊ PHÂN (.bin) CHUẨN LITTLE-ENDIAN
// Node.js chạy trên x86/ARM nên buffer nội tại mặc định là Little-Endian (cùng chuẩn với WASM)
const outputDir = path.join(__dirname, 'public', 'api');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// Hàm chuyển TypedArray thành Buffer và ghi ra file
const writeBin = (filename, typedArray) => {
    // Không dùng vòng lặp, bê nguyên cục RAM đẩy thẳng xuống ổ cứng!
    const buffer = Buffer.from(typedArray.buffer); 
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, buffer);
    
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
    console.log(`✅ Đã ghi: ${filename} (${sizeMB} MB)`);
};

writeBin('hashtag_starts.bin', tag_starts);
writeBin('hashtag_lengths.bin', tag_lengths);
writeBin('hashtag_product_ids.bin', tag_product_ids);

console.timeEnd("⏱️ Tổng thời gian xử lý");
console.log(`🎉 Hoàn tất! Đã ánh xạ ${totalRelations.toLocaleString()} mối quan hệ.`);