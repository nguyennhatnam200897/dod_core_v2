// compiler_v44.js
import { allocMemory, hydrate, runDispatch, markBatch } from '../src/js/runtime_v44.js';

class CompilerContext {
    constructor() { this.reset(); }

    reset() {
        this.nodes = []; this.adjList = []; this.sinks = []; 
        this.actions = []; this.graphData = []; this.events = [];
        this.stringTable = [""];
        // Kho chứa danh bạ các cổng Public
        this.exports = {};
        // THÊM DÒNG NÀY ĐỂ TRÁNH LỖI UNDEFINED:
        this.exportedActions = {};
        // THÊM MỚI: Kho chứa các Action khởi chạy lúc Boot
        this.initActions = [];
    }

    onInit(actionId) {
        this.initActions.push(actionId);
    }

    // Hàm đăng ký cổng (được gọi từ framework)
    registerExport(portName, oldId, type) {
        if (this.exports[portName]) {
            throw new Error(`[Compiler] Port name '${portName}' is already declared.`);
        }
        // Lưu lại type gốc (ví dụ 'STR') vào nhãn semantic
        this.exports[portName] = { oldId, semantic: type }; 
    }

    registerExportAction(portName, actionId) {
        if (this.exportedActions[portName]) throw new Error(`[Compiler] Action port '${portName}' already declared.`);
        this.exportedActions[portName] = actionId;
    }

    // --- HELPER: Resolve Input ---
    _resolve(val) {
        if (typeof val === 'object' && val !== null) {
            // Hỗ trợ node nội bộ của compiler (_id)
            if (val.hasOwnProperty('_id')) return { id: val._id, type: val._type, isNode: true };
            // THÊM DÒNG NÀY: Hỗ trợ NodeHandle truyền từ framework sang (id)
            if (val.hasOwnProperty('id')) return { id: val.id, type: val.type, isNode: true }; 
        }
        if (typeof val === 'number') {
            return { code: val.toString(), type: Number.isInteger(val) ? 'I32' : 'F64', isNode: false };
        }
        if (typeof val === 'string') {
            let idx = this.stringTable.indexOf(val);
            if (idx === -1) { idx = this.stringTable.length; this.stringTable.push(val); }
            return { code: idx.toString(), type: 'STR', isNode: false }; 
        }
        throw new Error(`[DSL] Invalid input: ${val}`);
    }

    // --- 1. SIGNAL BUILDERS ---
    signal(val, explicitType = null) {
        const r = this._resolve(val);
        // Khai báo là finalType
        const finalType = explicitType || r.type; 
        
        // --- SỬA Ở ĐÂY: Dùng đúng biến finalType ---
        const physicalMem = (finalType === 'STR') ? 'I32' : finalType;
        const semanticType = (finalType === 'STR') ? 'STR' : 'NUM';

        const node = this._add({ 
            type: 'SIGNAL', 
            mem: physicalMem,      
            semantic: semanticType,
            val: r.isNode ? null : (r.code === 'true' ? 1 : r.code === 'false' ? 0 : Number(r.code)) 
        });
        return node;
    }

    // --- 2. COMPUTE BUILDERS (Math & Logic) ---
    _op(inputs, genFunc, forceType = null) {
        const resolvedInputs = inputs.map(i => this._resolve(i));
        const inputIds = resolvedInputs.filter(r => r.isNode).map(r => r.id);
        
        let resType = forceType ? forceType : (resolvedInputs.some(r => r.type === 'F64') ? 'F64' : 'I32');

        const physicalMem = (resType === 'STR') ? 'I32' : resType;
        const semanticType = (resType === 'STR') ? 'STR' : 'NUM';

        return this._add({
            type: 'COMPUTE', mem: physicalMem, semantic: semanticType, pipeline: 'COMPUTE', inputs: inputIds,
            skipJS: true, // 🌟 Não Trái (JS) bỏ qua, nhường trọn Toán học cho Rust
            // 🌟 NÂNG CẤP: Thêm tham số target để phân luồng ngôn ngữ
            gen: (accessors, target = 'JS') => {
                let accIdx = 0;
                const finalArgs = resolvedInputs.map(r => {
                    if (r.isNode) return accessors[accIdx++];
                    
                    // Rust rất khắt khe về kiểu dữ liệu. Nếu là F64, số nguyên tĩnh phải có .0 (vd: 100.0)
                    if (target === 'RUST' && r.type === 'F64' && !r.code.includes('.')) {
                         return `${r.code}.0`;
                    }
                    return r.code;
                });
                return genFunc(finalArgs, target);
            }
        });
    }

    // 2.1. Basic Math (Dùng chung cho cả JS và Rust)
    add(a, b) { return this._op([a, b], ([x, y]) => `(${x} + ${y})`); }
    sub(a, b) { return this._op([a, b], ([x, y]) => `(${x} - ${y})`); }
    mul(a, b) { return this._op([a, b], ([x, y]) => `(${x} * ${y})`); }
    // 🌟 RUST CHIA KIỂU FLOAT: Ép kiểu as f64
    div(a, b) { return this._op([a, b], ([x, y], t) => t === 'RUST' ? `(${x} as f64 / ${y} as f64)` : `(${x} / ${y})`, 'F64'); } 
    mod(a, b) { return this._op([a, b], ([x, y]) => `(${x} % ${y})`); }

    // 2.2. Variadic Math 
    sum(...args)     { return this._op(args, (vars) => `(${vars.join(' + ')})`); }
    product(...args) { return this._op(args, (vars) => `(${vars.join(' * ')})`); }
    max(...args)     { return this._op(args, (vars, t) => t === 'RUST' ? `(${vars.join(').max(')})` : `Math.max(${vars.join(', ')})`); }
    min(...args)     { return this._op(args, (vars, t) => t === 'RUST' ? `(${vars.join(').min(')})` : `Math.min(${vars.join(', ')})`); }

    // 2.3. Unary Math 
    abs(a) { return this._op([a], ([x], t) => t === 'RUST' ? `(${x}).abs()` : `Math.abs(${x})`); }
    sin(a) { return this._op([a], ([x], t) => t === 'RUST' ? `(${x}).sin()` : `Math.sin(${x})`, 'F64'); }
    cos(a) { return this._op([a], ([x], t) => t === 'RUST' ? `(${x}).cos()` : `Math.cos(${x})`, 'F64'); }

    // 2.4. Bitwise 
    bitAnd(a, b) { return this._op([a, b], ([x, y]) => `(${x} & ${y})`, 'I32'); }
    bitOr(a, b)  { return this._op([a, b], ([x, y]) => `(${x} | ${y})`, 'I32'); }
    bitXor(a, b) { return this._op([a, b], ([x, y]) => `(${x} ^ ${y})`, 'I32'); }
    lshift(a, b) { return this._op([a, b], ([x, y]) => `(${x} << ${y})`, 'I32'); }
    rshift(a, b) { return this._op([a, b], ([x, y]) => `(${x} >> ${y})`, 'I32'); }

    // 2.5. Relational & Logical (Lõi rẽ nhánh cho Rust & JS)
    _compare(a, b, operator) {
        const rA = this._resolve(a);
        const rB = this._resolve(b);
        const isStrA = rA.type === 'STR' || (rA.isNode && this.nodes[rA.id].semantic === 'STR');
        const isStrB = rB.type === 'STR' || (rB.isNode && this.nodes[rB.id].semantic === 'STR');

        // 🌟 BẢN VÁ: Nhận diện phép so sánh Chuỗi
        const isStringComparison = isStrA || isStrB;

        return this._add({
            type: 'COMPUTE', 
            mem: 'I32', 
            semantic: 'NUM', 
            pipeline: 'COMPUTE', 
            inputs: [rA.id, rB.id],
            // 🌟 KIẾN TRÚC HYBRID DOD: 
            // Nếu là Chuỗi -> Ép Não Trái (JS) làm việc. 
            // Nếu là Số -> Ép Não Phải (Rust) làm việc.
            skipRust: isStringComparison, 
            skipJS: !isStringComparison,  
            gen: (acc, target) => {
                if (target === 'RUST') {
                    if (isStringComparison) return `0`; // Rust mù chuỗi, trả về 0 để bỏ qua
                    const rustOp = operator === '===' ? '==' : '!=';
                    return `if ${acc[0]} ${rustOp} ${acc[1]} { 1 } else { 0 }`;
                }
                
                let valX = acc[0], valY = acc[1];
                if (isStrA) valX = `(${acc[0]} >= 0 ? (LUT[${acc[0]}] || LUT[0]) : getDynamicString(${acc[0]}))`;
                if (isStrB) valY = `(${acc[1]} >= 0 ? (LUT[${acc[1]}] || LUT[0]) : getDynamicString(${acc[1]}))`;
                return `(${valX} ${operator} ${valY} ? 1 : 0)`;
            }
        });
    }

    eq(a, b)  { return this._compare(a, b, '==='); }
    neq(a, b) { return this._compare(a, b, '!=='); }

    gt(a, b)  { return this._op([a, b], ([x, y], t) => t === 'RUST' ? `if ${x} > ${y} { 1 } else { 0 }` : `(${x} > ${y} ? 1 : 0)`, 'I32'); }
    lt(a, b)  { return this._op([a, b], ([x, y], t) => t === 'RUST' ? `if ${x} < ${y} { 1 } else { 0 }` : `(${x} < ${y} ? 1 : 0)`, 'I32'); }
    gte(a, b) { return this._op([a, b], ([x, y], t) => t === 'RUST' ? `if ${x} >= ${y} { 1 } else { 0 }` : `(${x} >= ${y} ? 1 : 0)`, 'I32'); }
    lte(a, b) { return this._op([a, b], ([x, y], t) => t === 'RUST' ? `if ${x} <= ${y} { 1 } else { 0 }` : `(${x} <= ${y} ? 1 : 0)`, 'I32'); }

    and(a, b) { return this._op([a, b], ([x, y], t) => t === 'RUST' ? `if ${x} != 0 && ${y} != 0 { 1 } else { 0 }` : `((${x} && ${y}) ? 1 : 0)`, 'I32'); }
    or(a, b)  { return this._op([a, b], ([x, y], t) => t === 'RUST' ? `if ${x} != 0 || ${y} != 0 { 1 } else { 0 }` : `((${x} || ${y}) ? 1 : 0)`, 'I32'); }
    not(a)    { return this._op([a], ([x], t) => t === 'RUST' ? `if ${x} == 0 { 1 } else { 0 }` : `(!${x} ? 1 : 0)`, 'I32'); }

    // 2.7. Cast (Ép kiểu Native)
    cast(input, targetType) {
        const r = this._resolve(input);
        const sourceNode = this.nodes[r.id];
        if (sourceNode.mem === targetType) return sourceNode; 
        
        const physicalMem = (targetType === 'STR') ? 'I32' : targetType;
        const semanticType = (targetType === 'STR') ? 'STR' : 'NUM';

        return this._add({
            type: 'COMPUTE', pipeline: 'COMPUTE', inputs: [r.id], mem: physicalMem, semantic: semanticType,
            skipJS: true, // 🌟 Nhường cho Rust ép kiểu
            gen: (acc, target) => {
                // Trình biên dịch sẽ tự chèn lệnh ép kiểu gốc của CPU
                if (target === 'RUST') return `${acc[0]} as ${targetType === 'F64' ? 'f64' : 'i32'}`;
                return `${acc[0]}`;
            } 
        });
    }

    // Lệnh chọc thẳng vào RAM Toàn cục (Tạm thời trả về 0 cho Rust để chuẩn bị cho bước gắn Database)
    globalRead(globalArrStr, idxInput, forceType, unpackConfig = null) {
        const rIdx = this._resolve(idxInput);
        const physicalMem = (forceType === 'STR') ? 'I32' : forceType;
        const semanticType = (forceType === 'STR') ? 'STR' : 'NUM';

        return this._add({
            type: 'COMPUTE', mem: physicalMem, semantic: semanticType, pipeline: 'COMPUTE', inputs: [rIdx.id],
            skipRust: true, // 🌟 Não Phải (Rust) bỏ qua, nhường cho JS đọc Database
            gen: (acc, target) => {
                if (target === 'RUST') return `0`; // 🌟 Bí kíp giữ Rust không lỗi ở bước này
                
                let valExpr = `${globalArrStr}[${acc[0]}]`;
                if (unpackConfig) {
                    if (unpackConfig.shift) valExpr = `(${valExpr} >> ${unpackConfig.shift})`;
                    if (unpackConfig.mask)  valExpr = `(${valExpr} & ${unpackConfig.mask})`;
                }
                if (forceType === 'STR') return `setDynamicString(${valExpr})`;
                return valExpr;
            }
        });
    }

    ifElse(cond, trueVal, falseVal) {
        const tInput = this._resolve(trueVal);
        return this._op(
            [cond, trueVal, falseVal], 
            ([c, t, f], target) => target === 'RUST' ? `if ${c} != 0 { ${t} } else { ${f} }` : `(${c} ? ${t} : ${f})`, 
            tInput.type
        );
    }

    // --- 3. SINK BUILDERS (Effects) ---
    bindText(selector, ...deps) {
        const resolvedDeps = deps.map(d => this._resolve(d));
        const inputIds = resolvedDeps.filter(r => r.isNode).map(r => r.id);

        const node = this._add({
            type: 'EFFECT', inputs: inputIds, pipeline: 'RENDER',
            meta: { type: 'TEXT', selector }, 
            gen: (acc) => {
                let accIdx = 0;
                const parts = resolvedDeps.map(r => {
                    if (r.isNode) {
                        const accessor = acc[accIdx++];
                        const sourceNode = this.nodes[r.id];
                        if (sourceNode.semantic === 'STR' || sourceNode.mem === 'STR') {
                            return `(${accessor} >= 0 ? (LUT[${accessor}] || LUT[0]) : getDynamicString(${accessor}))`;
                        } else return `String(${accessor})`; 
                    } else {
                        if (r.type === 'STR') return `(LUT[${r.code}] || LUT[0])`;
                        return `String(${r.code})`;
                    }
                });
                
                // SỬA Ở ĐÂY: Smart Hydration
                return `
                    const textVal = ${parts.join(' + ')};
                    if (CACHE[selfIdx] !== textVal) { 
                        if (CACHE[selfIdx] === null) {
                            if (DOM[selfIdx].textContent !== String(textVal)) DOM[selfIdx].textContent = textVal;
                        } else {
                            DOM[selfIdx].textContent = textVal;
                        }
                        CACHE[selfIdx] = textVal; 
                    }
                `;
            }
        });
        this.sinks.push(node._id);
        return node;
    }

    // THÊM MỚI: Ràng buộc Class CSS
    bindClass(dep, selector, className) {
        const d = this._resolve(dep);
        const node = this._add({ 
            type: 'EFFECT', inputs: [d.id], pipeline: 'RENDER',
            meta: { type: 'CLASS', selector, className },
            gen: (acc) => {
                return `const val = ${acc[0]};\n` +
                       `if (CACHE[selfIdx] !== val) { \n` +
                       `  if (CACHE[selfIdx] === null) {\n` +
                       `    const hasClass = DOM[selfIdx].classList.contains("${className}");\n` +
                       `    if (val && !hasClass) DOM[selfIdx].classList.add("${className}");\n` +
                       `    else if (!val && hasClass) DOM[selfIdx].classList.remove("${className}");\n` +
                       `  } else {\n` +
                       `    if (val) DOM[selfIdx].classList.add("${className}");\n` +
                       `    else DOM[selfIdx].classList.remove("${className}");\n` +
                       `  }\n` +
                       `  CACHE[selfIdx] = val; \n` +
                       `}`;
            }
        });
        this.sinks.push(node._id);
        return node;
    }

    // THÊM MỚI: Ẩn/Hiện phần tử
    bindShow(dep, selector, displayStyle = 'block') {
        const d = this._resolve(dep);
        const node = this._add({ 
            type: 'EFFECT', inputs: [d.id], pipeline: 'RENDER',
            meta: { type: 'SHOW', selector, displayStyle },
            gen: (acc) => {
                return `const val = ${acc[0]};\n` +
                       `if (CACHE[selfIdx] !== val) { \n` +
                       `  const targetStyle = val ? "${displayStyle}" : "none";\n` +
                       `  if (CACHE[selfIdx] === null) {\n` +
                       `    if (DOM[selfIdx].style.display !== targetStyle) DOM[selfIdx].style.display = targetStyle;\n` +
                       `  } else {\n` +
                       `    DOM[selfIdx].style.display = targetStyle;\n` +
                       `  }\n` +
                       `  CACHE[selfIdx] = val; \n` +
                       `}`;
            }
        });
        this.sinks.push(node._id);
        return node;
    }

    // THÊM MỚI: Ràng buộc CSS Nội tuyến (Inline Style)
    bindStyle(dep, selector, property, unit = '') {
        const d = this._resolve(dep);
        const node = this._add({
            type: 'EFFECT', inputs: [d.id], pipeline: 'RENDER',
            meta: { type: 'STYLE', selector, property, unit },
            gen: (acc) => {
                const sourceNode = this.nodes[d.id];
                const isStr = sourceNode.semantic === 'STR' || sourceNode.mem === 'STR';
                
                let code = `const rawVal = ${acc[0]};\n`;
                if (isStr) {
                    code += `const text = rawVal >= 0 ? (LUT[rawVal] || LUT[0]) : getDynamicString(rawVal);\n`;
                    code += `const finalVal = text + "${unit}";\n`;
                } else {
                    code += `const finalVal = rawVal + "${unit}";\n`;
                }
                
                code += `if (CACHE[selfIdx] !== finalVal) { \n`;
                code += `  if (CACHE[selfIdx] === null) {\n`;
                code += `    if (DOM[selfIdx].style["${property}"] !== finalVal) DOM[selfIdx].style["${property}"] = finalVal;\n`;
                code += `  } else {\n`;
                code += `    DOM[selfIdx].style["${property}"] = finalVal;\n`;
                code += `  }\n`;
                code += `  CACHE[selfIdx] = finalVal; \n`;
                code += `}`;
                return code;
            }
        });
        this.sinks.push(node._id);
        return node;
    }

    // 🌟 BẢN VÁ: Ràng buộc Input chống nhảy con trỏ (Caret Preservation)
    bindValue(dep, selector) {
        const d = this._resolve(dep);
        const sourceNode = this.nodes[d.id];
        // Kiểm tra xem dữ liệu gốc là String hay Number để giải mã cho đúng
        const isStr = sourceNode.semantic === 'STR' || sourceNode.mem === 'STR';

        const node = this._add({
            type: 'EFFECT', inputs: [d.id], pipeline: 'RENDER',
            meta: { type: 'VALUE', selector },
            gen: (acc) => {
                let valExpr = acc[0];
                if (isStr) {
                    valExpr = `(${acc[0]} >= 0 ? (LUT[${acc[0]}] || LUT[0]) : getDynamicString(${acc[0]}))`;
                }
                
                return `const val = String(${valExpr});\n` +
                       `if (CACHE[selfIdx] !== val) { \n` +
                       `  // CHỈ GHI ĐÈ NẾU DOM THỰC SỰ KHÁC BIỆT (Tránh chớp nháy input)\n` +
                       `  if (DOM[selfIdx].value !== val) {\n` +
                       `    const active = document.activeElement === DOM[selfIdx];\n` +
                       `    let start = 0, end = 0;\n` +
                       `    // BƯỚC 1: Lưu vị trí con trỏ nếu user đang gõ\n` +
                       `    if (active) { start = DOM[selfIdx].selectionStart; end = DOM[selfIdx].selectionEnd; }\n` +
                       `    \n` +
                       `    DOM[selfIdx].value = val;\n` +
                       `    \n` +
                       `    // BƯỚC 2: Trả con trỏ về vị trí cũ\n` +
                       `    if (active) DOM[selfIdx].setSelectionRange(start, end);\n` +
                       `  }\n` +
                       `  CACHE[selfIdx] = val; \n}`;
            }
        });
        this.sinks.push(node._id);
        return node;
    }

    bindAttr(dep, selector, attrName) {
        const d = this._resolve(dep);
        const node = this._add({
            type: 'EFFECT', inputs: [d.id], pipeline: 'RENDER',
            meta: { type: 'ATTR', selector }, 
            gen: (acc) => {
                const isStr = (this.nodes[d.id].mem || d.type) === 'STR';
                const isBool = ['disabled', 'checked', 'readonly', 'required', 'selected', 'hidden'].includes(attrName.toLowerCase());
                let code = `const val = ${acc[0]};\nif (CACHE[selfIdx] !== val) { \n`;
                if (isBool) {
                    code += `  if (CACHE[selfIdx] === null) {\n` +
                            `    const hasAttr = DOM[selfIdx].hasAttribute('${attrName}');\n` +
                            `    if (val && !hasAttr) DOM[selfIdx].setAttribute('${attrName}', '');\n` +
                            `    else if (!val && hasAttr) DOM[selfIdx].removeAttribute('${attrName}');\n` +
                            `  } else {\n` +
                            `    if (val) DOM[selfIdx].setAttribute('${attrName}', '');\n` +
                            `    else DOM[selfIdx].removeAttribute('${attrName}');\n` +
                            `  }\n`;
                } else {
                    code += `  const finalVal = ${isStr ? `val >= 0 ? (LUT[val] || LUT[0]) : getDynamicString(val)` : `val`};\n` +
                            `  if (CACHE[selfIdx] === null) {\n` +
                            `    if (DOM[selfIdx].getAttribute('${attrName}') !== String(finalVal)) DOM[selfIdx].setAttribute('${attrName}', finalVal);\n` +
                            `  } else { DOM[selfIdx].setAttribute('${attrName}', finalVal); }\n`;
                }
                code += `  CACHE[selfIdx] = val; \n}`;
                return code;
            }
        });
        this.sinks.push(node._id); return node;
    }

    // 🌟 THÊM MỚI: Ràng buộc tọa độ Y siêu tốc cho Virtual Scroll
    bindTransformY(dep, selector) {
        const d = this._resolve(dep);
        const node = this._add({
            type: 'EFFECT', inputs: [d.id], pipeline: 'RENDER',
            meta: { type: 'TRANSFORM_Y', selector },
            gen: (acc) => {
                // KHÔNG nối chuỗi ra biến val nữa. Chỉ truyền số nguyên.
                return `const val = ${acc[0]};\n` +
                    `if (CACHE[selfIdx] !== val) { \n` +
                    `  if (CACHE[selfIdx] === null) {\n` +
                    `    if (DOM[selfIdx].style.getPropertyValue('--y') !== val + "px") DOM[selfIdx].style.setProperty('--y', val + "px");\n` +
                    `  } else { DOM[selfIdx].style.setProperty('--y', val + "px"); }\n` +
                    `  CACHE[selfIdx] = val; \n}`;
            }
        });
        this.sinks.push(node._id);
        return node;
    }

    // Đăng ký Event
    bindEvent(selector, eventName, actionName, mapping, schema = {}) {
        const inputs = Object.keys(mapping).map(key => {
            let val = mapping[key];
            const expectedType = schema[key] || 'STR'; // Lấy type từ khai báo của Action

            // 1. Nếu user truyền chuỗi tĩnh (vd: "dataset.id" hoặc "value")
            if (typeof val === 'string') {
                // TỰ ĐỘNG SPLIT THÀNH MẢNG NGAY LÚC BIÊN DỊCH!
                // Giúp Runtime (lúc user gõ phím) không bao giờ phải chạy hàm split() nữa
                return { path: val.split('.'), expectedType };
            }
            
            // 2. Dữ liệu cứng (static object/number) truyền thẳng vào
            return { value: val, expectedType }; 
        });
        
        this.events.push({ selector, eventName, actionName, inputs });
    }

    // Xử lý Transaction Action
    mutationAction(name, argSignals, assignments, dispatches = []) {
        this.actions.push({ type: 'MUTATION', name, argSignals, assignments, dispatches });
    }

    // --- HÀM ĐỆ QUY GIẢI NÉN PHƯƠNG TRÌNH TOÁN HỌC ---
    _buildInlineExpr(nodeId, memMap, oldToNew) {
        const node = this.nodes[nodeId];
        const newId = oldToNew[nodeId];
        // Nếu là Node tính toán, đệ quy bung logic của nó ra
        if (node.type === 'COMPUTE' || node.type === 'CAST') {
            const args = node.inputs.map(depId => this._buildInlineExpr(depId, memMap, oldToNew));
            return `(${node.gen(args, 'JS')})`; // 🌟 BẢN VÁ: Phải truyền rõ target là 'JS'
        }
        // Nếu là Signal (State/Input), lấy giá trị thẳng từ RAM
        return `${node.mem}[${memMap[newId]}]`;
    }

    _genActions(newNodes, memMap, oldToNew) {
        return this.actions.map(act => {
            if (act.type === 'MUTATION') {
                const argKeys = Object.keys(act.argSignals);
                let code = `${act.name}: (${argKeys.join(', ')}) => { const {F64, I32, U8, FLAGS_C, L2_C, L1_C, FLAGS_R, L2_R, L1_R, GRAPH} = mem;\n`;
                
                argKeys.forEach(key => {
                    const newId = oldToNew[act.argSignals[key]];
                    const node = this.nodes[act.argSignals[key]];
                    
                    if (node.semantic === 'STR') {
                        code += `const _newVal_${key} = setDynamicString(${key});\n`;
                        code += `if (${node.mem}[${memMap[newId]}] !== _newVal_${key}) {\n`;
                        code += `  if (${node.mem}[${memMap[newId]}] < 0) releaseDynamicString(${node.mem}[${memMap[newId]}]);\n`;
                        code += `  ${node.mem}[${memMap[newId]}] = _newVal_${key};\n`;
                        code += `} else {\n`;
                        code += `  if (_newVal_${key} < 0) releaseDynamicString(_newVal_${key});\n`;
                        code += `}\n`;
                    } else {
                        code += `${node.mem}[${memMap[newId]}] = ${key};\n`;
                    }
                    code += this._propagateHybrid(act.argSignals[key], oldToNew, -1, 'COMPUTE', -1);
                });

                // 🌟 BẢN VÁ TỐI THƯỢNG: TÍNH TOÁN CÁC THAM SỐ GỬI ĐI TRƯỚC KHI GHI ĐÈ RAM!
                if (act.dispatches && act.dispatches.length > 0) {
                    act.dispatches.forEach((d, idx) => {
                        if (d.type === 'CALL') {
                            d._tempArgs = d.argIds.map((oldId, i) => {
                                const expr = this._buildInlineExpr(oldId, memMap, oldToNew);
                                code += `const _disp_${idx}_arg_${i} = ${expr};\n`;
                                return `_disp_${idx}_arg_${i}`;
                            });
                        } else if (d.type === 'SEND') {
                            const expr = this._buildInlineExpr(d.sourceId, memMap, oldToNew);
                            code += `const _disp_${idx}_val = ${expr};\n`;
                            d._tempVal = `_disp_${idx}_val`;
                        } else if (d.type === 'CALL_JS') {
                            d._tempArgs = d.argIds.map((oldId, i) => {
                                const expr = this._buildInlineExpr(oldId, memMap, oldToNew);
                                code += `const _disp_${idx}_arg_${i} = ${expr};\n`;
                                return `_disp_${idx}_arg_${i}`;
                            });
                        }
                    });
                }

                // CHẠY ASSIGNMENTS ĐỂ CẬP NHẬT TRẠNG THÁI VÀO RAM
                act.assignments.forEach(assign => {
                    const targetNew = oldToNew[assign.targetId];
                    const targetNode = this.nodes[assign.targetId];
                    const inlineExpr = this._buildInlineExpr(assign.sourceId, memMap, oldToNew);
                    
                    code += `const _tempVal_${assign.targetId} = ${inlineExpr};\n`;
                    
                    if (targetNode.semantic === 'STR') {
                        code += `if (_tempVal_${assign.targetId} < 0) retainDynamicString(_tempVal_${assign.targetId});\n`;
                        code += `if (${targetNode.mem}[${memMap[targetNew]}] < 0) releaseDynamicString(${targetNode.mem}[${memMap[targetNew]}]);\n`;
                        code += `${targetNode.mem}[${memMap[targetNew]}] = _tempVal_${assign.targetId};\n`;
                    } else if (targetNode.mem === 'F64') {
                        code += `${targetNode.mem}[${memMap[targetNew]}] = +_tempVal_${assign.targetId};\n`;
                    } else {
                        code += `${targetNode.mem}[${memMap[targetNew]}] = (_tempVal_${assign.targetId}) | 0;\n`;
                    }
                    
                    code += this._propagateHybrid(assign.targetId, oldToNew, -1, 'COMPUTE', -1);
                });

                // XẢ CÁC DISPATCH BẰNG NHỮNG BIẾN TẠM ĐÃ TÍNH Ở TRÊN
                if (act.dispatches && act.dispatches.length > 0) {
                    act.dispatches.forEach((d, idx) => {
                        if (d.type === 'SEND') {
                            const sourceNew = oldToNew[d.sourceId];
                            const sourceNode = this.nodes[d.sourceId];
                            const tempVar = d._tempVal; 
                            if (sourceNode.semantic === 'STR' || sourceNode.mem === 'STR') {
                                code += `Motherboard.sendSignal("${d.targetComponent}", "${d.portName}", ${tempVar} >= 0 ? (LUT[${tempVar}] || LUT[0]) : getDynamicString(${tempVar}));\n`;
                            } else {
                                code += `Motherboard.sendSignal("${d.targetComponent}", "${d.portName}", ${tempVar});\n`;
                            }
                        } else if (d.type === 'CALL') {
                            const argExprs = d._tempArgs.map((tempVar, i) => {
                                const oldId = d.argIds[i];
                                const node = this.nodes[oldId];
                                if (node.semantic === 'STR' || node.mem === 'STR') {
                                    return `${tempVar} >= 0 ? (LUT[${tempVar}] || LUT[0]) : getDynamicString(${tempVar})`;
                                }
                                return tempVar;
                            });
                            code += `Motherboard.callAction("${d.targetComponent}", "${d.portName}", ${argExprs.join(', ')});\n`;
                        } else if (d.type === 'RENDER_LIST') {
                            let mapCode = `Motherboard.renderList("${d.poolName}", ${d.dataSource}, (instanceName, rowData) => {\n`;
                            for (const jsonKey in d.mapping) {
                                mapCode += `  Motherboard.sendSignal(instanceName, "${d.mapping[jsonKey]}", rowData.${jsonKey});\n`;
                            }
                            mapCode += `});\n`;
                            code += mapCode;
                        } else if (d.type === 'VIRTUAL_LIST') {
                            let mapCode = `Motherboard.initVirtualScroll("${d.poolName}", "${d.containerSelector}", ${d.dataSource}, ${d.itemHeight}, (instanceMbId, rowData, rowIndex) => {\n`;
                            for (const jsonKey in d.mapping) {
                                if (jsonKey === '$index') mapCode += `  Motherboard.sendSignal(instanceMbId, "${d.mapping[jsonKey]}", rowIndex);\n`;
                                else mapCode += `  Motherboard.sendSignal(instanceMbId, "${d.mapping[jsonKey]}", rowData.${jsonKey});\n`;
                            }
                            mapCode += `});\n`;
                            code += mapCode;
                        } else if (d.type === 'CALL_JS') {
                            const argExprs = d._tempArgs.map((tempVar, i) => {
                                const oldId = d.argIds[i];
                                const node = this.nodes[oldId];
                                if (node.semantic === 'STR' || node.mem === 'STR') {
                                    return `${tempVar} >= 0 ? (LUT[${tempVar}] || LUT[0]) : getDynamicString(${tempVar})`;
                                }
                                return tempVar;
                            });
                            code += `if (typeof window["${d.fnName}"] === 'function') window["${d.fnName}"](${argExprs.join(', ')});\n`;
                        }
                    });
                }

                code += `Motherboard.wakeUp(); }`;
                return code;
            }
            return '';
        }).join(',\n    ');
    }

    // --- INTERNAL GRAPH MANAGERS ---
    _add(node) {
        const id = this.nodes.length;
        node._id = id;
        node._type = node.mem;
        this.nodes.push(node);
        this.adjList[id] = [];
        
        if (node.inputs) {
            node.inputs.forEach(d => {
                if (!this.adjList[d]) this.adjList[d] = [];
                this.adjList[d].push(id);
            });
        }
        return node; 
    }

    _performTopologicalSort() {
        const sorted = [], visited = new Set(), visiting = new Set();
        const visit = (nodeId) => {
            if (visited.has(nodeId)) return;
            if (visiting.has(nodeId)) throw new Error("Cycle detected");
            visiting.add(nodeId);
            if (this.nodes[nodeId].inputs) this.nodes[nodeId].inputs.forEach(visit);
            visiting.delete(nodeId);
            visited.add(nodeId);
            sorted.push(nodeId);
        };
        this.sinks.forEach(sinkId => visit(sinkId));
        for (let i = 0; i < this.nodes.length; i++) visit(i);
        return sorted;
    }

    _genDirtyMark(nodeIdx, type) {
        const suffix = type === 'C' ? '_C' : '_R';
        const flagIdx = nodeIdx >>> 5; const flagBit = 31 - (nodeIdx & 31);
        const l2Idx = flagIdx >>> 5; const l2Bit = 31 - (flagIdx & 31);
        const l1Idx = l2Idx >>> 5; const l1Bit = 31 - (l2Idx & 31);
        return `FLAGS${suffix}[${flagIdx}] |= ${1 << flagBit}; L2${suffix}[${l2Idx}] |= ${1 << l2Bit}; L1${suffix}[${l1Idx}] |= ${1 << l1Bit}; `;
    }

    _genBatchInline(start, end, type) {
        const suffix = type === 0 ? '_C' : '_R';
        return `markBatch(FLAGS${suffix}, L2${suffix}, L1${suffix}, GRAPH, ${start}, ${end}); `;
    }

    _propagateHybrid(originalId, oldToNew, currentBlockIdx, currentPipeline, currentNodeIdx) {
        let code = "";
        if (this.adjList[originalId]) {
            const updatesC = []; const updatesR = [];
            const localUpdates = new Set();
            
            // 🌟 BẢN VÁ: Lấy thông tin của Node hiện tại để xác định "Quốc tịch" (JS hay Rust)
            const currentNode = this.nodes[originalId];

            this.adjList[originalId].forEach(childOld => {
                const childNode = this.nodes[childOld];
                const childNew = oldToNew[childOld];
                const childBlockIdx = childNew >>> 5;
                const childBit = 31 - (childNew & 31);
                
                // 🌟 KIỂM TRA BIÊN GIỚI: Cha và Con có đang chạy chung trên 1 Bán Cầu Não không?
                // (Cùng chạy JS, hoặc Cùng chạy Rust)
                const isSameEngine = !!currentNode.skipJS === !!childNode.skipJS;

                // CHỈ cho phép dùng biến cục bộ (Local Mask) nếu chạy CÙNG MỘT NÃO
                if (isSameEngine && childBlockIdx === currentBlockIdx && childNode.pipeline === currentPipeline && childNew > currentNodeIdx) {
                    localUpdates.add(1 << childBit);
                } else {
                    // NẾU VƯỢT BIÊN GIỚI (JS gọi Rust) -> Bắt buộc ghi thẳng xuống RAM cứng (updatesC)
                    if (childNode.pipeline === 'COMPUTE') updatesC.push(childNew); else updatesR.push(childNew);
                }
            });
            
            if (localUpdates.size > 0) { 
                let mask = 0; localUpdates.forEach(m => mask |= m); 
                code += `mask |= ${mask}; `; 
            }

            const INLINE_THRESHOLD = 4;
            if (updatesC.length > 0) {
                if (updatesC.length < INLINE_THRESHOLD) updatesC.forEach(nid => code += this._genDirtyMark(nid, 'C'));
                else { const s = this.graphData.length; this.graphData.push(...updatesC); code += this._genBatchInline(s, this.graphData.length, 0); }
            }
            if (updatesR.length > 0) {
                if (updatesR.length < INLINE_THRESHOLD) updatesR.forEach(nid => code += this._genDirtyMark(nid, 'R'));
                else { const s = this.graphData.length; this.graphData.push(...updatesR); code += this._genBatchInline(s, this.graphData.length, 1); }
            }
        }
        return code;
    }

    _genPipelineChunks(nodes, memMap, oldToNew, flagCount, targetPipeline, prefix) {
        const l2Count = Math.ceil(flagCount / 32);
        const definitions = [];
        for (let l2 = 0; l2 < l2Count; l2++) {
            const startF = l2 * 32, endF = Math.min((l2+1)*32, flagCount);
            let blockCode = `const { F64, I32, U8, FLAGS_C, L2_C, L1_C, FLAGS_R, L2_R, L1_R, DOM, CACHE, GRAPH } = mem;\nlet v=0, _res=0;\n`;
            let hasAnyNodes = false;

            for (let f = startF; f < endF; f++) {
                let funcBody = "";
                let hasFlagNodes = false;
                const startN = f * 32, endN = Math.min((f+1)*32, nodes.length);
                
                for (let n = startN; n < endN; n++) {
                    const node = nodes[n];
                    if (node.pipeline === targetPipeline) {
                        if (prefix === 'c' && node.skipJS) continue;
                        hasFlagNodes = true;
                        const bit = 31 - (n % 32);
                        funcBody += `if (mask & ${1 << bit}) { `;
                        
                        const selfMemIdx = memMap[n];
                        const inputAccessors = node.inputs.map(oldDepId => {
                            const depNewId = oldToNew[oldDepId];
                            const depNode = this.nodes[oldDepId]; 
                            return `${depNode.mem}[${memMap[depNewId]}]`;
                        });
                        
                        if (node.type === 'EFFECT') {
                            let effectCode = node.gen(inputAccessors, 'JS');
                            effectCode = effectCode.replace(/selfIdx/g, selfMemIdx);
                            funcBody += effectCode;
                        } else if (node.type === 'COMPUTE') {
                            const logic = node.gen(inputAccessors, 'JS');
                            const isIntTarget = node.mem === 'I32' || node.mem === 'U8';
                            
                            if (isIntTarget) funcBody += `v = (${logic}) | 0; `;
                            else             funcBody += `v = +(${logic}); `;

                            funcBody += `if (${node.mem}[${selfMemIdx}] !== v) { `;

                            if (node.semantic === 'STR') {
                                funcBody += `  if (v < 0) retainDynamicString(v); `;
                                funcBody += `  if (${node.mem}[${selfMemIdx}] < 0) releaseDynamicString(${node.mem}[${selfMemIdx}]); `;
                            }
                            funcBody += `  ${node.mem}[${selfMemIdx}] = v; `;

                            funcBody += this._propagateHybrid(node._oldId, oldToNew, f, node.pipeline, n);
                            funcBody += `} `;
                        }
                        funcBody += ` } \n`;
                    }
                }
                if (hasFlagNodes) {
                    hasAnyNodes = true;
                    definitions.push(`const ${prefix}_exec_${f} = (mem, mask) => { \n ${blockCode} \n ${funcBody} };`);
                } else {
                    definitions.push(`const ${prefix}_exec_${f} = null;`);
                }
            }
        }
        return definitions;
    }

    // ==============================================================
    // 🌟 TRÌNH BIÊN DỊCH AOT (JS SANG RUST)
    // ==============================================================
    // 🌟 THÊM THAM SỐ componentName
    _genRustBackend(nodes, memMap, oldToNew, flagCount, componentName) { 
        // 🌟 BỎ VỎ BỌC impl, CHỈ SINH MÃ CHO NHÁNH match CỦA COMPONENT NÀY
        let rustCode = `            "${componentName}" => {\n                match chunk_id {\n`;

        const l2Count = Math.ceil(flagCount / 32);
        for (let l2 = 0; l2 < l2Count; l2++) {
            const startF = l2 * 32, endF = Math.min((l2+1)*32, flagCount);
            for (let f = startF; f < endF; f++) {
                let hasFlagNodes = false;
                let funcBody = `                    ${f} => {\n`;

                const startN = f * 32, endN = Math.min((f+1)*32, nodes.length);
                for (let n = startN; n < endN; n++) {
                    const node = nodes[n];
                    if (node.pipeline === 'COMPUTE') {
                        if (node.skipRust) continue;
                        hasFlagNodes = true;
                        const bit = 31 - (n % 32);
                        funcBody += `                        if (mask & (1 << ${bit})) != 0 {\n`;
                        
                        const selfMemIdx = memMap[n];
                        const inputAccessors = node.inputs.map(oldDepId => {
                            const depNewId = oldToNew[oldDepId];
                            const depNode = this.nodes[oldDepId]; 
                            return `self.${depNode.mem.toLowerCase()}_mem[${memMap[depNewId]}]`;
                        });
                        
                        const logic = node.gen(inputAccessors, 'RUST');
                        const targetType = node.mem === 'F64' ? 'f64' : 'i32';
                        
                        funcBody += `                            let v = (${logic}) as ${targetType};\n`;
                        
                        const rustMemName = node.mem.toLowerCase();
                        funcBody += `                            if self.${rustMemName}_mem[${selfMemIdx}] != v {\n`;
                        funcBody += `                                self.${rustMemName}_mem[${selfMemIdx}] = v;\n`;
                        
                        if (this.adjList[node._oldId]) {
                            this.adjList[node._oldId].forEach(childOld => {
                                const childNew = oldToNew[childOld];
                                const cNode = this.nodes[childOld];
                                const suffix = cNode.pipeline === 'COMPUTE' ? 'c' : 'r';
                                
                                const flagIdx = childNew >>> 5; const flagBit = 31 - (childNew & 31);
                                const l2Idx = flagIdx >>> 5; const l2Bit = 31 - (flagIdx & 31);
                                const l1Idx = l2Idx >>> 5; const l1Bit = 31 - (l2Idx & 31);
                                
                                // 🌟 BẢN VÁ TỐI THƯỢNG: Xử lý Đói Tín Hiệu (Starvation)
                                // Nếu Node con nằm cùng 1 Chunk Toán học (flagIdx === f), cập nhật thẳng vào biến mask!
                                if (suffix === 'c' && flagIdx === f) {
                                    funcBody += `                                mask |= 1 << ${flagBit};\n`;
                                } else {
                                    // Bắn tín hiệu sang Chunk khác (RAM cứng)
                                    funcBody += `                                self.flags_${suffix}[${flagIdx}] |= 1 << ${flagBit};\n`;
                                    funcBody += `                                self.l2_${suffix}[${l2Idx}] |= 1 << ${l2Bit};\n`;
                                    funcBody += `                                self.l1_${suffix}[${l1Idx}] |= 1 << ${l1Bit};\n`;
                                }
                            });
                        }
                        funcBody += `                            }\n                        }\n`;
                    }
                }
                funcBody += `                    },\n`;
                if (hasFlagNodes) rustCode += funcBody;
            }
        }
        rustCode += `                    _ => {}\n                }\n            },\n`;
        return rustCode;
    }

    compile(componentName = 'App') {
        const nodes = this.nodes;
        const sortedIDs = this._performTopologicalSort();
        const oldToNew = new Array(nodes.length);
        const newNodes = sortedIDs.map((oldId, newIdx) => { oldToNew[oldId] = newIdx; const n = nodes[oldId]; n._oldId = oldId; return n; });
        this.graphData = [];
        
        const counts = { f64: 0, i32: 0, u8: 0, sinks: 0, totalNodes: nodes.length, graphSize: 0 };
        
        const stringIndices = []; 

        const memMap = newNodes.map((n, newIdx) => { 
            if (n.type === 'EFFECT') { counts.sinks++; return counts.sinks - 1; } 
            if (n.mem === 'F64') return counts.f64++; 
            if (n.mem === 'I32') {
                const idx = counts.i32++;
                // THÊM DÒNG NÀY: Nếu Node này chứa chuỗi, lưu index lại để sau này Recycle dọn rác
                if (n.semantic === 'STR') stringIndices.push(idx);
                return idx;
            }
            if (n.mem === 'U8')  return counts.u8++; 
            return -1; 
        });

        // Giành riêng 1 byte U8 cuối cùng làm cờ Ngủ đông (Tránh xung đột với user)
        const isActiveIndex = counts.u8; 
        counts.u8++;

        const bucketCount = Math.ceil(nodes.length/32);
        const defsC = this._genPipelineChunks(newNodes, memMap, oldToNew, bucketCount, 'COMPUTE', 'c');
        const defsR = this._genPipelineChunks(newNodes, memMap, oldToNew, bucketCount, 'RENDER', 'r');

        // THÊM MỚI: Dịch địa chỉ Public Ports
        let exportedPortsCode = "{\n";
        for (const portName in this.exports) {
            const info = this.exports[portName];
            const newId = oldToNew[info.oldId];
            
            // --- SỬA Ở ĐÂY: Dùng info.oldId thay vì newId để trỏ đúng mảng cũ ---
            const targetNode = this.nodes[info.oldId]; 
            
            const memoryIndex = memMap[newId];
            
            // Compiler tự động sinh ra mã đánh thức các Node con của Cổng này!
            const propagateCode = this._propagateHybrid(info.oldId, oldToNew, -1, 'COMPUTE', -1);
            
            exportedPortsCode += `  "${portName}": { \n`;
            exportedPortsCode += `    id: ${memoryIndex}, \n`;
            exportedPortsCode += `    type: "${targetNode.mem}", \n`;
            exportedPortsCode += `    semantic: "${info.semantic}", \n`;
            exportedPortsCode += `    propagate: (mem) => { const { FLAGS_C, L2_C, L1_C, FLAGS_R, L2_R, L1_R, GRAPH } = mem; ${propagateCode} } \n`;
            exportedPortsCode += `  },\n`;
        }
        exportedPortsCode += "}";

        // 🌟 BẢN VÁ: Chạy bộ sinh mã Action TRƯỚC để gom đủ Dữ liệu Đồ thị (GRAPH)
        const actionsCode = this._genActions(newNodes, memMap, oldToNew);

        // SAU ĐÓ mới chốt kích thước của mảng GRAPH
        counts.graphSize = this.graphData.length;
        
        const initData = { 
            F64: newNodes.filter(n=>n.mem==='F64').map(n=>n.val||0), 
            I32: newNodes.filter(n=>n.mem==='I32').map(n=>n.val||0), 
            // Nạp số 1 vào slot cuối cùng để Component mặc định được cắm điện!
            U8:  [...newNodes.filter(n=>n.mem==='U8').map(n=>n.val||0), 1] 
        };
        
        // 🌟 BẢN VÁ: Lọc bỏ các Node Toán học ẩn, chỉ giữ lại Node Effect (DOM)
        const fingerprint = this.sinks
            .filter(oldId => nodes[oldId].type === 'EFFECT') 
            .map(oldId => { 
                const n = nodes[oldId]; const newId = oldToNew[oldId]; 
                return { idx: memMap[newId], ...n.meta }; 
            });

        const buildFuncArray = (defs, name) => {
            const names = defs.map(d => {
                const match = d.match(/const\s+([a-z0-9_]+)\s+=/);
                return match ? match[1] : 'null';
            });
            return `const ${name} = [\n${names.join(', ')}\n];`;
        };

        // THÊM BIẾN NÀY VÀO ĐÂY (NGOÀI KHỐI RETURN STRING)
        const exportedActionsCode = JSON.stringify(this.exportedActions || {});

        // Tạo biến jsCode chứa toàn bộ code cũ
        const jsCode = `// --- COMPONENT: ${componentName} ---
const create${componentName} = (() => {
    const COUNTS = ${JSON.stringify(counts)};
    const FINGERPRINT = ${JSON.stringify(fingerprint)};
    const LUT = ${JSON.stringify(this.stringTable)};
    const EVENTS = ${JSON.stringify(this.events)};
    const SINKS = ${JSON.stringify(this.sinks.filter(oldId => this.nodes[oldId].type === 'EFFECT').map(oldId => oldToNew[oldId]))};

    // Các hàm tính toán c_exec_x được giữ lại dưới dạng "dự phòng", 
    // trong thực tế khi chạy WASM, mảng này không còn được đụng tới nữa.
    ${defsC.join('\n')}
    ${defsR.join('\n')}

    ${buildFuncArray(defsC, 'BATCHES_C')}
    ${buildFuncArray(defsR, 'BATCHES_R')}

    const EXPORTED_PORTS = ${exportedPortsCode};

    return function(root, actions = {}, instanceId = "") {
        const finalName = instanceId !== "" ? "${componentName}_" + instanceId : "${componentName}";
        
        const mem = allocMemory(COUNTS, "${componentName}");
        const { F64, I32, U8, DOM, CACHE, GRAPH, FLAGS_C, L2_C, L1_C, FLAGS_R, L2_R, L1_R } = mem; 
        
        F64.set([${initData.F64}]); 
        I32.set([${initData.I32}]); 
        U8.set([${initData.U8}]);
        GRAPH.set([${this.graphData.join(',')}]);

        hydrate(root, FINGERPRINT, mem.DOM, mem.CACHE);

        Object.assign(actions, {
            ${actionsCode}
        });

        const _mbId = Motherboard.register(finalName, mem, BATCHES_C, BATCHES_R, EXPORTED_PORTS, ${exportedActionsCode}, actions, ${isActiveIndex});
        bindEvents(root, EVENTS, _mbId);

        for (let i = 0; i < COUNTS.totalNodes; i++) {
            const flagIdx = i >>> 5; const flagBit = 31 - (i & 31);
            const l2Idx = flagIdx >>> 5; const l2Bit = 31 - (flagIdx & 31);
            const l1Idx = l2Idx >>> 5; const l1Bit = 31 - (l2Idx & 31);
            FLAGS_C[flagIdx] |= (1 << flagBit); L2_C[l2Idx] |= (1 << l2Bit); L1_C[l1Idx] |= (1 << l1Bit);
            FLAGS_R[flagIdx] |= (1 << flagBit); L2_R[l2Idx] |= (1 << l2Bit); L1_R[l1Idx] |= (1 << l1Bit);
        }
        Motherboard.enqueue(_mbId);
        Motherboard.wakeUp();

        const STR_INDICES = ${JSON.stringify(stringIndices)};

        ${this.initActions.length > 0 ? `setTimeout(() => {\n            ${this.initActions.map(id => `actions.${id}();`).join('\n            ')}\n            Motherboard.enqueue(_mbId);\n            Motherboard.wakeUp();\n        }, 0);` : ''}

        return {
            plug: () => plug(root, mem, ${isActiveIndex}, FLAGS_R, L2_R, L1_R, SINKS),
            unplug: () => { unplug(root, mem, ${isActiveIndex}); },
            detach: () => {
                unplug(root, mem, ${isActiveIndex});
                root.__parent = root.parentNode; root.__nextSibling = root.nextSibling;
                if (root.parentNode) root.remove(); 
            },
            restore: () => {
                if (root.__parent) root.__parent.insertBefore(root, root.__nextSibling); 
                plug(root, mem, ${isActiveIndex}, FLAGS_R, L2_R, L1_R, SINKS); 
            },
            recycle: () => {
                unplug(root, mem, ${isActiveIndex}); 
                for (let i = 0; i < STR_INDICES.length; i++) {
                    const strId = mem.I32[STR_INDICES[i]];
                    if (strId < 0) { releaseDynamicString(strId); mem.I32[STR_INDICES[i]] = 0; }
                }
            },
            _mbId, _poolId: instanceId !== "" ? instanceId : -1, _name: finalName, _dataIndex: -2, _rootNode: root
        };
    }
})();`;

        // 🌟 GỌI BỘ PHIÊN DỊCH RUST
        const rustCode = this._genRustBackend(newNodes, memMap, oldToNew, bucketCount, componentName);

        // 🌟 TRẢ VỀ CẢ 2 BÁN CẦU NÃO
        return {
            js: jsCode,
            rust: rustCode
        };
    }
}
// Thêm dòng này vào cuối cùng của file compiler_v44.js
export const compiler = new CompilerContext();