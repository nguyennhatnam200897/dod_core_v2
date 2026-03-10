use wasm_bindgen::prelude::*;

// 🌟 KIẾN TRÚC BỘ NHỚ CHÍNH (MOTHERBOARD MEMORY)
#[wasm_bindgen]
pub struct MotherboardCore {
    comp_name: String, // 🌟 THÊM DÒNG NÀY: Tên Component (VD: "ProductItem")
    
    f64_mem: Vec<f64>,
    i32_mem: Vec<i32>,
    u8_mem:  Vec<u8>,
    
    flags_c: Vec<u32>,
    l2_c:    Vec<u32>,
    l1_c:    Vec<u32>,
    
    flags_r: Vec<u32>,
    l2_r:    Vec<u32>,
    l1_r:    Vec<u32>,
}

#[wasm_bindgen]
impl MotherboardCore {
    #[wasm_bindgen(constructor)]
    // 🌟 THÊM comp_name: String VÀO THAM SỐ ĐẦU TIÊN
    pub fn new(comp_name: String, f64_count: usize, i32_count: usize, _u8_count: usize, total_nodes: usize) -> MotherboardCore {
        let count_l0 = (total_nodes as f32 / 32.0).ceil() as usize;
        let count_l1 = (count_l0 as f32 / 32.0).ceil() as usize;
        let count_l2 = (count_l1 as f32 / 32.0).ceil() as usize;

        MotherboardCore {
            comp_name, // 🌟 LƯU TÊN LẠI
            f64_mem: vec![0.0; f64_count],
            i32_mem: vec![0; i32_count],
            u8_mem:  vec![0; f64_count], 
            flags_c: vec![0; count_l0],
            l2_c:    vec![0; count_l1],
            l1_c:    vec![0; count_l2],
            flags_r: vec![0; count_l0],
            l2_r:    vec![0; count_l1],
            l1_r:    vec![0; count_l2],
        }
    }

    // =========================================================
    // 🌟 XUẤT KHẨU CON TRỎ (POINTERS) ĐỂ JS CÓ THỂ ĐỌC TRỰC TIẾP
    // =========================================================
    pub fn ptr_f64(&self) -> *const f64 { self.f64_mem.as_ptr() }
    pub fn ptr_i32(&self) -> *const i32 { self.i32_mem.as_ptr() }
    pub fn ptr_u8(&self)  -> *const u8  { self.u8_mem.as_ptr() }
    pub fn ptr_flags_c(&self) -> *const u32 { self.flags_c.as_ptr() }
    pub fn ptr_l2_c(&self) -> *const u32 { self.l2_c.as_ptr() }
    pub fn ptr_l1_c(&self) -> *const u32 { self.l1_c.as_ptr() }
    pub fn ptr_flags_r(&self) -> *const u32 { self.flags_r.as_ptr() }
    pub fn ptr_l2_r(&self) -> *const u32 { self.l2_r.as_ptr() }
    pub fn ptr_l1_r(&self) -> *const u32 { self.l1_r.as_ptr() }

    // =========================================================
    // 🌟 VÒNG LẶP ĐIỀU PHỐI (COMPUTE DISPATCHER)
    // Tốc độ C++ nguyên bản - Không Garbage Collector
    // =========================================================
    pub fn tick_compute(&mut self) {
        let len = self.l1_c.len();
        
        for i in 0..len {
            let mut mask_l1 = self.l1_c[i];
            if mask_l1 == 0 { continue; }
            self.l1_c[i] = 0; // Tắt cờ

            while mask_l1 != 0 {
                let offset_l1 = mask_l1.leading_zeros();
                mask_l1 &= !(1 << (31 - offset_l1));
                let l2_idx = (i << 5) + (offset_l1 as usize);

                let mut mask_l2 = self.l2_c[l2_idx];
                if mask_l2 == 0 { continue; }
                self.l2_c[l2_idx] = 0;

                while mask_l2 != 0 {
                    let offset_l2 = mask_l2.leading_zeros();
                    mask_l2 &= !(1 << (31 - offset_l2));
                    let flag_idx = (l2_idx << 5) + (offset_l2 as usize);

                    let mask_flags = self.flags_c[flag_idx];
                    if mask_flags == 0 { continue; }
                    self.flags_c[flag_idx] = 0;

                    // GỌI HÀM THỰC THI LOGIC (Compiler sẽ sinh mã Rust cho hàm này)
                    self.execute_batch(flag_idx, mask_flags);
                }
            }
        }
    }
}
// Nhúng file Rust do JS sinh ra vào kiến trúc hệ thống
mod generated_compute;