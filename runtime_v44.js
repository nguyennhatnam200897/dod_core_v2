// runtime_v44.js
import initWasm, { MotherboardCore } from './pkg/dod_core.js';
// ==============================================================
// 🌟 HÀNG ĐỢI MẢNG VÒNG (RING BUFFER) O(1) - ZERO ALLOCATION
// ==============================================================
const MAX_COMPONENTS = 65536;
const QUEUE = new Int32Array(MAX_COMPONENTS);
const IN_QUEUE = new Uint8Array(MAX_COMPONENTS);
let qHead = 0;
let qTail = 0;

// THÊM ĐOẠN NÀY VÀO NGAY DƯỚI:
// ==============================================================
// 🌟 HỘP THƯ SỰ KIỆN (INPUT BUFFER) - BẢO VỆ LUỒNG TÍNH TOÁN
// ==============================================================
const EVENT_QUEUE_SIZE = 4096; // Sức chứa 4096 sự kiện chưa xử lý
const EQ_COMP_IDS = new Array(EVENT_QUEUE_SIZE);
const EQ_ACTION_NAMES = new Array(EVENT_QUEUE_SIZE); 
const EQ_PAYLOADS = new Array(EVENT_QUEUE_SIZE);
let eqHead = 0;
let eqTail = 0;

export const Motherboard = {
    components: new Array(MAX_COMPONENTS),
    nameToId: new Map(),
    compCount: 0,
    pools: {},
    lazyRegistry: {}, // 🌟 THÊM MỚI: Sổ đăng ký Component lười biếng
    isComputing: false,
    isRenderScheduled: false,
    
    // 🌟 BẢN VÁ ROUTER: Rút phích cắm diện rộng để tránh rò rỉ bộ nhớ (Memory Leak)
    unplugTree: (containerNode) => {
        for (let i = 0; i < Motherboard.components.length; i++) {
            const comp = Motherboard.components[i];
            // Nếu Component đang sống và DOM của nó nằm trong vùng sắp bị xóa
            if (comp && comp._rootNode && containerNode.contains(comp._rootNode)) {
                if (comp.recycle) comp.recycle(); // Giải phóng chuỗi & Tắt cờ Rust
                else if (comp.unplug) comp.unplug();
                
                Motherboard.components[i] = undefined; // Giải phóng RAM cho JS
            }
        }
    },

    // 🌟 THÊM MỚI: Khai báo Component nhưng chưa cấp phát RAM
    registerLazy: (name, factoryFn, templateSelector, containerSelector) => {
        Motherboard.lazyRegistry[name] = { factoryFn, templateSelector, containerSelector, isMounted: false };
    },

    // 🌟 THÊM MỚI: Lò ấp JIT (Nặn DOM và cắm điện ngay lúc được gọi)
    _ensureMounted: (targetName) => {
        const lazyInfo = Motherboard.lazyRegistry[targetName];
        if (lazyInfo && !lazyInfo.isMounted) {
            const template = document.querySelector(lazyInfo.templateSelector);
            const container = document.querySelector(lazyInfo.containerSelector);
            if (template && container) {
                // 1. Nhân bản từ Template (Không tốn chi phí Parse HTML)
                const clone = template.content.cloneNode(true);
                const rootNode = clone.firstElementChild; 
                container.appendChild(rootNode); // Bơm vào màn hình
                
                // 2. Cấp phát RAM và Cắm điện
                lazyInfo.factoryFn(rootNode);
                lazyInfo.isMounted = true;
                console.log(`[Engine JIT] Đã khởi tạo lười biếng: ${targetName} ⚡`);
            }
        }
    },

    // 🌟 THÊM MỚI: API Ly Khai Trang (Dành cho Router)
    detach: (targetName) => {
        const id = Motherboard.nameToId.get(targetName);
        if (id === undefined) return;
        const comp = Motherboard.components[id];
        // Gọi hàm detach đã được compiler sinh ra
        if (comp && comp.actions && typeof comp.actions.detach === 'function') {
            comp.actions.detach();
        } else if (comp && typeof comp.detach === 'function') {
            comp.detach(); // Dành cho instances
        }
    },

    // 🌟 THÊM MỚI: API Phục Hồi Trang (Dành cho Router)
    restore: (targetName) => {
        const id = Motherboard.nameToId.get(targetName);
        if (id === undefined) return;
        const comp = Motherboard.components[id];
        if (comp && comp.actions && typeof comp.actions.restore === 'function') {
            comp.actions.restore();
        } else if (comp && typeof comp.restore === 'function') {
            comp.restore();
        }
    },

    register: (name, mem, BATCHES_C, BATCHES_R, exportedNodeIds = {}, exportedActions = {}, actions = {}, isActiveIndex = 0) => {
        // 🌟 Cấp cho mỗi Component một "Mã số định danh" (ID Nguyên thủy)
        const id = Motherboard.compCount++;
        const comp = { id, name, mem, BATCHES_C, BATCHES_R, nodes: exportedNodeIds, exportedActions, actions, isActiveIndex };
        
        Motherboard.components[id] = comp;
        Motherboard.nameToId.set(name, id);
        return id; // Trả về ID để Compiler sử dụng
    },

    // 🌟 THUẬT TOÁN ĐẨY VÀO HÀNG ĐỢI O(1)
    enqueue: (id) => {
        if (IN_QUEUE[id] === 0) {
            IN_QUEUE[id] = 1;
            QUEUE[qTail] = id;
            // Phép thuật Bitwise: (X + 1) % 65536 cực nhanh
            qTail = (qTail + 1) & 65535; 
        }
    },

    // 🌟 THÊM MỚI 1: Bỏ sự kiện vào hộp thư (Không xử lý ngay)
    pushEvent: (mbId, actionName, args) => {
        EQ_COMP_IDS[eqTail] = mbId;
        EQ_ACTION_NAMES[eqTail] = actionName;
        EQ_PAYLOADS[eqTail] = args;
        
        // Tịnh tiến đuôi mảng vòng O(1)
        eqTail = (eqTail + 1) & (EVENT_QUEUE_SIZE - 1);
        
        // Đánh thức Engine dậy để chuẩn bị gom mẻ lưới
        Motherboard.wakeUp();
    },

    // 🌟 THÊM MỚI 2: Xả toàn bộ hộp thư (Chỉ được gọi bởi vòng lặp của Engine)
    flushEvents: () => {
        while (eqHead !== eqTail) {
            // Lấy thư ra đọc
            const mbId = EQ_COMP_IDS[eqHead];
            const actionName = EQ_ACTION_NAMES[eqHead];
            const args = EQ_PAYLOADS[eqHead];
            
            // Tịnh tiến đầu mảng vòng
            eqHead = (eqHead + 1) & (EVENT_QUEUE_SIZE - 1);
            
            const comp = Motherboard.components[mbId];
            if (comp && comp.actions && comp.actions[actionName]) {
                // Kích hoạt ghi RAM
                comp.actions[actionName](...args);
                // Báo cáo Component này đã bị bẩn (Dirty) để Engine biết mà tính toán
                Motherboard.enqueue(mbId);
            }
        }
    },

    callAction: (target, actionPortName, ...args) => {
        if (typeof target === 'string') Motherboard._ensureMounted(target);
        
        const id = typeof target === 'string' ? Motherboard.nameToId.get(target) : target;
        if (id === undefined) return;
        const targetComp = Motherboard.components[id];
        const actionId = targetComp.exportedActions[actionPortName];
        
        if (actionId && targetComp.actions[actionId]) {
            Motherboard.pushEvent(id, actionId, args);
        }
    },
    
    // get: (name) => Motherboard.registry[name],

    sendSignal: (target, portName, value) => {
        // 🌟 BẢN VÁ: Đánh chặn truyền tín hiệu IPC
        if (typeof target === 'string') Motherboard._ensureMounted(target);

        const id = typeof target === 'string' ? Motherboard.nameToId.get(target) : target;
        if (id === undefined) return;

        const targetComp = Motherboard.components[id];
        const port = targetComp.nodes[portName];
        if (!port) return;

        let tempPtr = value;

        if (port.semantic === 'STR') {
            if (typeof value === 'string') tempPtr = setDynamicString(value); 
            else if (typeof value === 'number' && value < 0) tempPtr = retainDynamicString(value); 
        } else {
            tempPtr = (port.type === 'F64') ? Number(value) : (Number(value) | 0);
            if (isNaN(tempPtr)) tempPtr = 0;
        }

        const memoryArray = targetComp.mem[port.type];
        const oldValue = memoryArray[port.id];

        if (oldValue !== tempPtr) {
            if (port.semantic === 'STR' && oldValue < 0) releaseDynamicString(oldValue);
            memoryArray[port.id] = tempPtr;
            if (port.propagate) port.propagate(targetComp.mem);
            
            // 🌟 ĐẨY VÀO MẢNG VÒNG THAY VÌ SET
            Motherboard.enqueue(id);
            Motherboard.wakeUp();
        } else {
            if (port.semantic === 'STR' && tempPtr < 0) releaseDynamicString(tempPtr);
        }
    },


    // --- THÊM MỚI: API Render Danh sách từ Object Pool ---
    renderList: (poolName, dataArray, mappingFn) => {
        const pool = Motherboard.pools[poolName];
        if (!pool) {
            console.error(`[Motherboard] Không tìm thấy Pool '${poolName}'`);
            return;
        }

        const currentActive = pool.activeList.length;
        const newTarget = dataArray.length;

        // 1. Thu hồi các Component thừa (Nếu dữ liệu mới ít hơn số lượng đang hiển thị)
        while (pool.activeList.length > newTarget) {
            const instance = pool.activeList.pop();
            instance.recycle(); // Dọn rác RAM, ẩn DOM
            pool.freeList.push(instance); // Trả về kho
        }

        // 2. Cấp phát và Bắn dữ liệu
        for (let i = 0; i < newTarget; i++) {
            let instance;
            // Nếu màn hình đang thiếu, rút từ Kho rảnh rỗi ra
            if (i >= currentActive) {
                if (pool.freeList.length === 0) {
                    console.warn(`[Motherboard] Pool '${poolName}' đã cạn kiệt! (Sức chứa: ${pool.activeList.length}). Vui lòng tăng poolSize.`);
                    break;
                }
                instance = pool.freeList.pop();
                pool.activeList.push(instance);
            } else {
                // Tái sử dụng Component đang hiển thị sẵn trên màn hình
                instance = pool.activeList[i];
            }

            // Gọi hàm mapping do Dev định nghĩa để bắn dòng điện
            mappingFn(instance._name, dataArray[i], i);

            // Bật điện, ép Render ra DOM ngay lập tức
            instance.plug();
        }
        
        console.log(`[Engine] Đã render xong ${newTarget} items cho Pool '${poolName}'. (Kho còn: ${pool.freeList.length})`);
    },

    // ==============================================================
    // 🌟 THUẬT TOÁN THẤU KÍNH SSG (CÓ TỰ LÀM SẠCH KHI LỌC DATA) 🌟
    // ==============================================================
    initVirtualScroll: (poolName, containerSelector, dataArray, itemHeight, mappingFn) => {
        const container = document.querySelector(containerSelector);
        const pool = Motherboard.pools[poolName];
        if (!container || !pool) return;

        if (pool._isScrollBound) {
            pool._updateData(dataArray);
            return;
        }
        pool._isScrollBound = true;

        const spacer = container.querySelector('.virtual-spacer');
        if (!spacer) return;

        container.style.overflowY = 'auto';
        container.style.position = 'relative';
        container.style.willChange = 'transform';

        let currentData = dataArray;
        let lastStartIdx = -1;

        const renderFrame = (force = false) => {
            spacer.style.height = `${currentData.length * itemHeight}px`;

            const scrollTop = container.scrollTop;
            const viewportHeight = container.clientHeight;

            // 🌟 TỐI ƯU 1: THUẬT TOÁN OVERSCAN (Tận dụng 100% Cỗ máy trong Pool)
            const visibleCount = Math.ceil(viewportHeight / itemHeight); 
            // Dàn đều số item dư thừa trong Pool lên trên và xuống dưới vùng nhìn thấy
            const overscan = Math.max(0, Math.floor((pool.poolSize - visibleCount) / 2)); 

            let startIdx = Math.floor(scrollTop / itemHeight) - overscan;
            if (startIdx < 0) startIdx = 0;

            let endIdx = Math.min(currentData.length - 1, startIdx + pool.poolSize - 1);
            
            // Ép startIdx lùi lại nếu scroll chạm đáy để luôn xài hết 100% sức mạnh của Pool
            startIdx = Math.max(0, endIdx - pool.poolSize + 1);

            if (!force && startIdx === lastStartIdx) return;
            lastStartIdx = startIdx;

            // BƯỚC 1: ĐỊNH TUYẾN DỮ LIỆU
            let usedCount = 0;
            for (let i = startIdx; i <= endIdx; i++) {
                if (i < 0 || i >= currentData.length) continue;
                
                const physicalIdx = i % pool.poolSize; 
                const inst = pool.instances[physicalIdx];
                usedCount++;
                
                if (inst._dataIndex !== i) {
                    inst._dataIndex = i;
                    // TRUYỀN THÊM rowIndex VÀO MAPPING NHƯ BẠN ĐÃ CẬP NHẬT Ở BƯỚC TRƯỚC
                    mappingFn(inst._mbId, null, i);
                    Motherboard.sendSignal(inst._mbId, 'TRANSFORM_Y', i * itemHeight);
                }
            }

            // BƯỚC 2: Dọn dẹp (Chỉ kích hoạt khi Data có ít hơn số lượng thẻ trong Pool)
            const orphanCount = pool.poolSize - usedCount;
            if (orphanCount > 0) {
                let orphanIdx = (endIdx + 1) % pool.poolSize;
                for (let k = 0; k < orphanCount; k++) {
                    const inst = pool.instances[orphanIdx];
                    if (inst._dataIndex !== -1) {
                         Motherboard.sendSignal(inst._mbId, 'TRANSFORM_Y', -99999);
                         inst._dataIndex = -1; 
                    }
                    orphanIdx = (orphanIdx + 1) % pool.poolSize;
                }
            }
        };

        pool._updateData = (newData) => {
            currentData = newData;
            
            // 🌟 BẢN VÁ: KỸ THUẬT CACHE INVALIDATION (PHÁ CACHE)
            // Ép toàn bộ thẻ sản phẩm trong Pool "quên" vị trí cũ bằng index -1
            for (let i = 0; i < pool.poolSize; i++) {
                const inst = pool.instances[i];
                if (inst._dataIndex !== -1) {
                    // Gửi -1 vào hệ thống để phá Cache của Lõi Toán học
                    mappingFn(inst._mbId, null, -1);
                    inst._dataIndex = -1; // Phá Cache của Virtual Scroll
                }
            }
            
            container.scrollTop = 0; 
            renderFrame(true); // Ép render lại mảng mới cực mạnh
        };

        // 🌟 TỐI ƯU 2: Bỏ requestAnimationFrame bao bọc bên ngoài!
        // Vì bên trong Motherboard đã có rAF ở pipeline RENDER rồi, bọc ở đây sẽ làm trễ 1 khung hình.
        // Dùng thêm { passive: true } để trình duyệt tăng tốc luồng cuộn GPU.
        container.addEventListener('scroll', () => renderFrame(false), { passive: true });
        renderFrame(true); 
    },


    // Đánh thức luồng tính toán
    wakeUp: () => {
        if (!Motherboard.isComputing) {
            Motherboard.isComputing = true;
            queueMicrotask(() => Motherboard.tickCompute());
        }
    },

    // Chỉ chạy BATCHES_C (Logic & Toán học)
    tickCompute: () => {
        Motherboard.isComputing = true;

        // 🌟 MỚI: XẢ TOÀN BỘ SỰ KIỆN TỪ USER TRƯỚC KHI TÍNH TOÁN!
        Motherboard.flushEvents();

        while (qHead !== qTail) {
            const id = QUEUE[qHead];
            qHead = (qHead + 1) & 65535; 
            IN_QUEUE[id] = 0;            

            const comp = Motherboard.components[id];
            if (!comp || comp.mem.U8[comp.isActiveIndex] === 0) continue;

            // 🌟 1. BÁN CẦU TRÁI (JS): Chạy để đọc window.DB (globalRead)
            // keepFlags = true để giữ nguyên Cờ cho Rust
            runDispatch(comp.mem, comp.mem.L1_C, comp.mem.L2_C, comp.mem.FLAGS_C, comp.BATCHES_C, true);

            // 🌟 2. BÁN CẦU PHẢI (Rust): Chạy toán học và tự động dọn dẹp Cờ (Clear Flags)
            comp.mem._rustCore.tick_compute();
        }

        Motherboard.isComputing = false;

        if (!Motherboard.isRenderScheduled) {
            Motherboard.isRenderScheduled = true;
            requestAnimationFrame(() => Motherboard.tickRender());
        }
    },

    // Chỉ chạy BATCHES_R (Cập nhật DOM)
    tickRender: () => {
        const len = Motherboard.compCount;
        for (let i = 0; i < len; i++) {
            const comp = Motherboard.components[i];
            if (!comp || comp.mem.U8[comp.isActiveIndex] === 0) continue;
            
            let compDirty = false;
            for (let j = 0; j < comp.mem.L1_R.length; j++) { 
                if (comp.mem.L1_R[j] !== 0) { compDirty = true; break; } 
            }
            if (compDirty) runDispatch(comp.mem, comp.mem.L1_R, comp.mem.L2_R, comp.mem.FLAGS_R, comp.BATCHES_R);
        }
        Motherboard.isRenderScheduled = false;
    }
};

// ==============================================================
// 🌟 KỶ NGUYÊN ZERO-ALLOCATION: STRING ARENA BUMP ALLOCATOR 🌟
// ==============================================================
const ARENA_CAPACITY = 4 * 1024 * 1024; // Cấp phát cứng 4MB RAM cho toàn bộ chuỗi động
export const STRING_ARENA = new Uint8Array(ARENA_CAPACITY);
let arenaHead = 0; // Con trỏ tịnh tiến (Chỉ tiến lên, không bao giờ lùi)

// SoA Metadata (Thay thế Array Object JS bằng RAM Tĩnh)
const MAX_STR_NODES = 65536; // Quản lý tối đa 64,000 chuỗi
const STR_OFFSET = new Uint32Array(MAX_STR_NODES); // Lưu vị trí bắt đầu
const STR_LEN    = new Uint32Array(MAX_STR_NODES); // Lưu độ dài byte
const STR_REFS   = new Int32Array(MAX_STR_NODES);  // Đếm số lượng Node đang dùng
const STR_FREE   = new Int32Array(MAX_STR_NODES);  // Kho chứa ID rảnh rỗi
let metaCount = 0;
let freeHead = 0;

// Bộ mã hóa/Giải mã phần cứng của Trình duyệt (Rất nhanh và không xả rác)
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// RETAIN (Ghi chuỗi vào RAM thô)
export function setDynamicString(str) {
    if (typeof str !== 'string') return str; 

    // 1. Cấp phát ID Nguyên thủy O(1)
    let idx;
    if (freeHead > 0) {
        freeHead--;
        idx = STR_FREE[freeHead];
    } else {
        idx = metaCount++;
    }

    // Ước tính kích thước byte tối đa (UTF-8 có thể chiếm tới 3-4 bytes/ký tự)
    const maxBytes = str.length * 4; 

    // 🌟 PHÉP MÀU DOD: NẾU TRÀN RAM -> DỒN RÁC THỦ CÔNG (DEFRAGMENTATION)
    if (arenaHead + maxBytes > ARENA_CAPACITY) {
        compactArena();
        if (arenaHead + maxBytes > ARENA_CAPACITY) {
            console.error("[Engine Fatal] String Arena bị tràn! Hãy tăng ARENA_CAPACITY.");
            return 0; // Fallback an toàn
        }
    }

    // 2. ZERO-ALLOCATION ENCODE: Ghi đè trực tiếp vào RAM, không sinh ra object JS mới
    const encodeResult = encoder.encodeInto(str, STRING_ARENA.subarray(arenaHead));

    // 3. Cập nhật Metadata
    STR_OFFSET[idx] = arenaHead;
    STR_LEN[idx] = encodeResult.written;
    STR_REFS[idx] = 1;

    // Tịnh tiến con trỏ
    arenaHead += encodeResult.written;

    return -(idx + 1); // Trả về ID âm (Giữ nguyên chuẩn cũ của Compiler)
}

export function retainDynamicString(id) {
    if (id >= 0) return id;
    const idx = -(id) - 1;
    if (STR_REFS[idx] > 0) STR_REFS[idx]++;
    return id;
}

export function releaseDynamicString(id) {
    if (id >= 0) return;
    const idx = -(id) - 1;
    
    if (STR_REFS[idx] > 0) {
        STR_REFS[idx]--;
        
        // Khi không còn ai dùng, chỉ việc trả ID về kho rảnh rỗi.
        // Tuyệt đối KHÔNG xóa byte trong STRING_ARENA. Byte cũ sẽ tự bị ghi đè sau này.
        if (STR_REFS[idx] === 0) {
            STR_FREE[freeHead] = idx;
            freeHead++;
        }
    }
}

// ==============================================================
// 🌟 BỘ GOM RÁC CƠ HỌC (THAY THẾ V8 GC) 🌟
// Chạy cực nhanh nhờ TypedArray.copyWithin cấp thấp của C++
// ==============================================================
function compactArena() {
    // console.warn("[Engine] Bắt đầu dồn phân mảnh String Arena...");
    let newHead = 0;
    
    for (let i = 0; i < metaCount; i++) {
        // Chỉ giữ lại những chuỗi đang SỐNG trên màn hình
        if (STR_REFS[i] > 0) {
            const len = STR_LEN[i];
            const oldOffset = STR_OFFSET[i];
            
            // Dịch chuyển byte lên đầu Arena (Overscan an toàn)
            if (newHead !== oldOffset) {
                STRING_ARENA.copyWithin(newHead, oldOffset, oldOffset + len);
                STR_OFFSET[i] = newHead; // Cập nhật lại tọa độ mới
            }
            newHead += len;
        }
    }
    
    arenaHead = newHead;
    // console.log(`[Engine] Dồn RAM xong. Đã thu hồi và nén gọn còn: ${arenaHead} bytes.`);
}

// 🌟 HÀM XUẤT CHUỖI RA DOM (Chỉ giải mã ĐÚNG MỘT LẦN khi Render)
export function getDynamicString(id) {
    if (id >= 0) return ""; 
    const idx = -(id) - 1;
    const offset = STR_OFFSET[idx];
    const len = STR_LEN[idx];
    // Đây là nơi duy nhất JS Engine tạo ra String Object, và nó cắm thẳng vào DOM
    return decoder.decode(STRING_ARENA.subarray(offset, offset + len));
}

// Khai báo biến toàn cục lưu trữ WASM
let wasmModule = null;
let core = null;

export async function bootEngineWasm() {
    // 1. Tải lõi Rust/WASM
    wasmModule = await initWasm();
    console.log("🚀 Lõi C++/Rust đã được kích hoạt!");
}

// 2. Viết lại hàm allocMemory (Cướp quyền quản lý RAM)
// 🌟 THÊM THAM SỐ compName
export function allocMemory(counts, compName) {
    if (!wasmModule) throw new Error("Chưa khởi động WASM Engine!");

    const core = new MotherboardCore(compName, counts.f64, counts.i32, counts.u8, counts.totalNodes);
    const memory = wasmModule.memory.buffer;

    return {
        // 🌟 BẢN VÁ: Lưu lại con trỏ Rust của riêng Component này
        _rustCore: core, 
        
        F64: new Float64Array(memory, core.ptr_f64(), counts.f64),
        I32: new Int32Array(memory, core.ptr_i32(), counts.i32),
        U8:  new Uint8Array(memory, core.ptr_u8(), counts.u8),
        
        FLAGS_C: new Uint32Array(memory, core.ptr_flags_c(), Math.ceil(counts.totalNodes/32)),
        L2_C:    new Uint32Array(memory, core.ptr_l2_c(), Math.ceil(counts.totalNodes/1024)),
        L1_C:    new Uint32Array(memory, core.ptr_l1_c(), Math.ceil(counts.totalNodes/32768)),
        
        FLAGS_R: new Uint32Array(memory, core.ptr_flags_r(), Math.ceil(counts.totalNodes/32)),
        L2_R:    new Uint32Array(memory, core.ptr_l2_r(), Math.ceil(counts.totalNodes/1024)),
        L1_R:    new Uint32Array(memory, core.ptr_l1_r(), Math.ceil(counts.totalNodes/32768)),
        
        GRAPH:   new Int32Array(counts.graphSize),
        DOM: [], CACHE: []
    };
}

// Cập nhật hàm hydrate (Kết hợp DOM giả ngay từ đầu nếu thiếu)
export function hydrate(root, fingerprint, domArray, cacheArray) {

    fingerprint.forEach(target => {
        // 🌟 BẢN VÁ: Kiểm tra xem chính thẻ root có khớp với selector không
        // Nếu khớp thì lấy chính nó, nếu không thì mới lục tìm bên trong (querySelector)
        let node = null;
        if (root.matches && root.matches(target.selector)) {
            node = root;
        } else {
            node = root.querySelector(target.selector);
        }
        
        if (node) {
            // PLUGGED
            if (target.type === 'TEXT') {
                if (node.childNodes.length === 0) node.appendChild(document.createTextNode(''));
                domArray[target.idx] = node.firstChild;
            } else {
                domArray[target.idx] = node;
            }
        } else {
            console.error(`[Headless] Unplugged from start: ${target.selector}`);
        }
        if (cacheArray) cacheArray[target.idx] = null;
    });
}

// 🔌 UNPLUG: Đóng băng Logic và Ẩn Giao diện (Rút điện)
export function unplug(root, mem, isActiveIndex) {
    // 1. Ngắt cầu dao Logic: Ghi số 0 vào bộ nhớ
    // Motherboard sẽ đọc byte này và bỏ qua toàn bộ tính toán cho Component
    mem.U8[isActiveIndex] = 0;

    // 2. Ẩn DOM: Trình duyệt ngừng Layout/Paint cho vùng này
    // Chú ý: DOM vẫn nằm đó, không hề bị xóa đi.
    root.style.display = 'none';
}

// ⚡ PLUG: Thức tỉnh Logic, Hiện Giao diện và Ép Đồng bộ (Cắm điện)
export function plug(root, mem, isActiveIndex, FLAGS_R, L2_R, L1_R, SINKS) {
    // 1. Bật lại cầu dao Logic: Ghi số 1 vào bộ nhớ
    mem.U8[isActiveIndex] = 1;

    // 2. Hiển thị lại DOM
    root.style.display = ''; 

    // 3. Ép bật Bitmask cho toàn bộ Sinks (Render Nodes)
    // Cực kỳ quan trọng: Trong lúc Component ngủ, dữ liệu có thể đã đổi.
    // Việc bật cờ này sẽ ép Engine xả dữ liệu mới nhất từ RAM ra DOM thật.
    for (let i = 0; i < SINKS.length; i++) {
        const idx = SINKS[i];
        const flagIdx = idx >>> 5;
        const flagBit = 31 - (idx & 31);
        const l2Idx = flagIdx >>> 5;
        const l2Bit = 31 - (flagIdx & 31);
        const l1Idx = l2Idx >>> 5;
        const l1Bit = 31 - (l2Idx & 31);
        
        FLAGS_R[flagIdx] |= (1 << flagBit);
        L2_R[l2Idx] |= (1 << l2Bit);
        L1_R[l1Idx] |= (1 << l1Bit);
    }

    // 4. Kích hoạt Motherboard chạy (phòng khi Engine đang ngủ đông toàn cục)
    Motherboard.wakeUp();
}

// 1. Sổ đăng ký sự kiện toàn cục (Tránh gắn trùng lặp)
const globalEventRegistry = new Set();

// 2. Trạm gác sự kiện ở cấp độ Body
function initGlobalDelegation(eventName) {
    if (globalEventRegistry.has(eventName)) return;
    globalEventRegistry.add(eventName);

    document.body.addEventListener(eventName, (e) => {
        // Tìm ngược lên trên xem có thẻ nào chứa cú pháp x-* không (VD: x-click)
        const targetEl = e.target.closest(`[x-${eventName}]`);
        if (!targetEl) return;

        // Đọc tên Action cần kích hoạt
        const actionName = targetEl.getAttribute(`x-${eventName}`);
        
        // Tìm Component gốc đang chứa thẻ này
        const componentRoot = targetEl.closest('[data-mb-id]');
        if (!componentRoot) return;

        // Rút ID của Component để truy xuất vào Motherboard
        const mbId = componentRoot.getAttribute('data-mb-id');
        const comp = Motherboard.components[mbId];

        if (comp && comp.actions && comp.actions[actionName]) {
            // Giải mã cấu hình đầu vào do Compiler chuẩn bị sẵn
            const inputsRaw = targetEl.getAttribute('x-inputs');
            const inputsConfig = inputsRaw ? JSON.parse(inputsRaw) : [];
            
            // Trích xuất dữ liệu từ Event (Ví dụ: e.target.value)
            const args = inputsConfig.map(input => {
                if (input.path) {
                    let val = targetEl;
                    for (let j = 0; j < input.path.length; j++) {
                        if (val) val = val[input.path[j]];
                    }
                    
                    if (input.expectedType === 'I32' || input.expectedType === 'F64') {
                        const num = Number(val);
                        return isNaN(num) ? 0 : num; // Bắt lỗi số học
                    }
                    return val;
                }
                return input.value; // Trả về giá trị tĩnh nếu có
            });

            // 🌟 MỚI: Đẩy lệnh vào Hộp thư thoại (Input Buffer)
            // Lưu ý: Chúng ta đẩy kèm cả biến 'e' (event gốc) vào cuối mảng args
            Motherboard.pushEvent(mbId, actionName, [...args, e]);
        }
    });
}

// 3. Hàm đóng dấu DOM lúc Hydrate (Không gắn Listener nữa)
export function bindEvents(root, EVENTS, mbId) {
    // Đóng dấu thẻ root để Trạm gác biết DOM này thuộc về cỗ máy nào
    if (root && root.setAttribute) {
        root.setAttribute('data-mb-id', mbId);
    }

    EVENTS.forEach(def => {
        // Bật trạm gác cho loại sự kiện này (chỉ chạy 1 lần duy nhất cho toàn app)
        initGlobalDelegation(def.eventName);
        
        // Tìm các phần tử đích và đóng mộc x-* lên chúng
        let elements = [];
        if (root.matches && root.matches(def.selector)) elements.push(root);
        const children = root.querySelectorAll(def.selector);
        for(let i=0; i<children.length; i++) elements.push(children[i]);

        elements.forEach(el => {
            // Cú pháp x-* cực kỳ thân thiện với HTML
            el.setAttribute(`x-${def.eventName}`, def.actionName);
            
            // Lưu lại cách trích xuất dữ liệu
            if (def.inputs && def.inputs.length > 0) {
                el.setAttribute('x-inputs', JSON.stringify(def.inputs));
            }
        });
    });
}

export function markBatch(FLAGS, L2, L1, GRAPH, start, end) {
    for (let i = start; i < end; i++) {
        const nodeIdx = GRAPH[i];
        const flagIdx = nodeIdx >>> 5;
        const flagBit = 31 - (nodeIdx & 31);
        const l2Idx = flagIdx >>> 5;
        const l2Bit = 31 - (flagIdx & 31);
        const l1Idx = l2Idx >>> 5;
        const l1Bit = 31 - (l2Idx & 31);
        
        FLAGS[flagIdx] |= (1 << flagBit);
        L2[l2Idx] |= (1 << l2Bit);
        L1[l1Idx] |= (1 << l1Bit);
    }
}

export function runDispatch(mem, L1, L2, FLAGS, BATCHES, keepFlags = false) {
    const len = L1.length;
    for (let i = 0; i < len; i++) {
        let maskL1 = L1[i];
        if (maskL1 === 0) continue;
        if (!keepFlags) L1[i] = 0; // 🌟 CHỈ XÓA NẾU KHÔNG GIỮ CỜ

        while (maskL1 !== 0) {
            const offsetL1 = Math.clz32(maskL1); 
            maskL1 &= ~(1 << (31 - offsetL1));   
            const l2Idx = (i << 5) + offsetL1;   
            
            let maskL2 = L2[l2Idx];
            if (maskL2 === 0) continue;
            if (!keepFlags) L2[l2Idx] = 0; // 🌟 CHỈ XÓA NẾU KHÔNG GIỮ CỜ

            while (maskL2 !== 0) {
                const offsetL2 = Math.clz32(maskL2);
                maskL2 &= ~(1 << (31 - offsetL2));
                const flagIdx = (l2Idx << 5) + offsetL2; 
                
                let maskFlags = FLAGS[flagIdx];
                if (maskFlags === 0) continue;
                if (!keepFlags) FLAGS[flagIdx] = 0; // 🌟 CHỈ XÓA NẾU KHÔNG GIỮ CỜ

                const batchFn = BATCHES[flagIdx];
                if (batchFn) batchFn(mem, maskFlags);
            }
        }
    }
}

// ==============================================================
// 🌟 KHỞI TẠO POOL (KỶ LUẬT THÉP - ZERO ALLOCATION) 🌟
// ==============================================================
export function initObjectPool(compName, factoryFn, containerSelector, poolSize) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    Motherboard.pools[compName] = {
        instances: [],
        poolSize,
        _isScrollBound: false
    };

    const itemNodes = Array.from(container.children).filter(node => !node.classList.contains('virtual-spacer'));

    if (itemNodes.length === 0) {
        throw new Error(`[Engine Fatal] Server không render bất kỳ thẻ mẫu nào cho Component '${compName}'.`);
    }

    if (itemNodes.length > poolSize) {
        throw new Error(`[SSG Violation] THẢM HỌA HIỆU NĂNG! Server gửi ${itemNodes.length} thẻ, vượt quá poolSize (${poolSize}).`);
    }

    // 🌟 BẢN VÁ B: CHẶT ĐỨT SỰ NƯƠNG TAY
    // Không tự clone Node nữa. Bắt buộc Server phải xuất đủ số lượng Pool Size!
    if (itemNodes.length < poolSize) {
        throw new Error(`[SSG Fatal] Server gửi THIẾU HTML (Có ${itemNodes.length}, Cần ${poolSize}). Engine từ chối cấp phát DOM lúc Runtime để bảo vệ hiệu năng! Hãy sửa vòng lặp render trên Server!`);
    }

    for (let i = 0; i < poolSize; i++) {
        let node = itemNodes[i];
        
        const instanceActions = {}; 
        const instance = factoryFn(node, instanceActions, i); 

        Motherboard.pools[compName].instances.push(instance);
        instance.plug(); 
    }
    console.log(`[Engine] SSG Lens thiết lập thành công: [${poolSize} Cỗ máy Bất tử]`);
}

// ==============================================================
// 🌟 TRÌNH ĐIỀU HƯỚNG DOD (STATIC VIEW POOLING ROUTER)
// ==============================================================
export const Router = {
    routes: {},             // Cấu hình bản đồ định tuyến
    viewInstances: {},      // Kho chứa các Component đã được "Cắm rễ" (để giữ cho DOM bất tử)
    activeViewName: null,   // Theo dõi trang đang được hiển thị

    // Khởi tạo Router với danh sách các tuyến đường
    init: (containerSelector, routesConfig) => {
        Router.routes = routesConfig;
        
        // Lắng nghe mọi cú click trên toàn trang (Event Delegation)
        document.body.addEventListener('click', e => {
            const a = e.target.closest('a[data-link]');
            if (a) {
                e.preventDefault();
                Router.navigate(a.getAttribute('href'), containerSelector, true);
            }
        });
        
        // Lắng nghe sự kiện Back/Forward của trình duyệt
        window.addEventListener('popstate', () => {
            Router.navigate(location.pathname, containerSelector, false);
        });

        // Kích hoạt trang đầu tiên ngay khi boot
        Router.navigate(location.pathname, containerSelector, false);
    },

    navigate: async (path, containerSelector, push) => {
        // 1. Tìm tuyến đường tương ứng (Fallback về 404 nếu không thấy)
        const route = Router.routes[path] || Router.routes['/404'];
        if (!route) {
            console.error(`[Router DOD] Lỗi: Không tìm thấy route cho ${path}`);
            return;
        }

        if (push) history.pushState({}, "", path);

        const targetName = route.name;
        const container = document.querySelector(containerSelector);
        if (!container) return;

        // -----------------------------------------------------------
        // 🌟 GIAI ĐOẠN 1: NGỦ ĐÔNG (UNPLUG) TRANG HIỆN TẠI (O(1))
        // -----------------------------------------------------------
        if (Router.activeViewName && Router.activeViewName !== targetName) {
            const oldInstance = Router.viewInstances[Router.activeViewName];
            if (oldInstance && typeof oldInstance.unplug === 'function') {
                // Rút điện RAM (Ghi số 0 vào mem.U8) và gán display: none
                oldInstance.unplug(); 
            }
        }

        // -----------------------------------------------------------
        // 🌟 GIAI ĐOẠN 2: THỨC TỈNH HOẶC CẮM RỄ TRANG MỚI
        // -----------------------------------------------------------
        let targetInstance = Router.viewInstances[targetName];

        if (!targetInstance) {
            // TRƯỜNG HỢP A: LẦN ĐẦU TIÊN TRUY CẬP (Lazy Allocation)
            console.log(`[Router DOD] ⚡ Bơm RAM & Cắm rễ View: ${targetName}...`);
            try {
                // Gọi Dynamic Import để tải Chunk (JS + Chuỗi HTML)
                const module = await route.fetcher();
                
                // Bơm HTML tĩnh vào cuối Container. Thao tác này chỉ tốn chi phí 1 LẦN DUY NHẤT.
                container.insertAdjacentHTML('beforeend', module.html);
                
                // Lấy thẻ gốc (root node) vừa được bơm vào
                const rootNode = container.lastElementChild;
                
                // Khởi tạo Component (Cấp phát RAM Rust, Hydrate, Đóng dấu Event)
                // module.factory chính là hàm createXYZ mà compiler sinh ra
                targetInstance = module.factory(rootNode);
                
                // Lưu vào kho để nó trở thành "Bất tử"
                Router.viewInstances[targetName] = targetInstance;
                
            } catch (err) {
                console.error(`[Router DOD] ❌ Lỗi tải chunk ${targetName}:`, err);
                return;
            }
        } else {
            // TRƯỜNG HỢP B: TỪ LẦN THỨ 2 TRỞ ĐI (Zero-Allocation Navigation)
            targetInstance.plug();
            Motherboard.enqueue(targetInstance._mbId);
            
            // 🌟 CHUẨN FRAMEWORK: Lõi Engine chỉ phát tín hiệu báo cáo vòng đời (Lifecycle hook)
            // Tuyệt đối không chứa logic dự án ở đây.
            window.dispatchEvent(new CustomEvent('dod:view-plugged', { detail: targetName }));
        }

        // 3. Cập nhật trạng thái và ép Frame tiếp theo render
        Router.activeViewName = targetName;
        Motherboard.wakeUp();
    }
};


// ==============================================================
// 🌟 KHO LƯU TRỮ TOÀN CỤC (GLOBAL STORE) - ENGINE KHÔNG CAN THIỆP
// ==============================================================
export const DB = {}; 
if (typeof window !== 'undefined') {
    window.DB = DB; // Phơi ra window để Component dễ truy xuất
}

// Trình giải mã chuỗi từ vùng nhớ Nhị phân (Engine cung cấp công cụ, Project tự nạp data)
const dbDecoder = new TextDecoder();
export let DB_STRING_MEM = null;

// API cho phép Project nạp vùng nhớ chứa chuỗi vào Engine
export function setDbStringMem(uint8Array) {
    DB_STRING_MEM = uint8Array;
}

export function getDbString(offset, length) {
    if (!DB_STRING_MEM) return "";
    return dbDecoder.decode(DB_STRING_MEM.subarray(offset, offset + length));
}