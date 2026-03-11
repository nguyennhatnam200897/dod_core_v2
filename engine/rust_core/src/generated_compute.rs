// 🚀 FILE TỰ ĐỘNG SINH BỞI ENGINE DOD
use super::MotherboardCore;

impl MotherboardCore {
    pub fn execute_batch(&mut self, chunk_id: usize, mut mask: u32) {
        match self.comp_name.as_str() {
            "HomeView" => {
                match chunk_id {
                    _ => {}
                }
            },

            "CartView" => {
                match chunk_id {
                    _ => {}
                }
            },

            _ => {}
        }
    }
}
