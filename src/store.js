// Quản lý giỏ hàng toàn cục trong RAM trình duyệt
export const CartStore = {
    items: new Map(), // Lưu trữ: productId -> quantity

    add(productId) {
        const currentQty = this.items.get(productId) || 0;
        this.items.set(productId, currentQty + 1);
        this.broadcast();
    },

    remove(productId) {
        this.items.delete(productId);
        this.broadcast();
    },

    broadcast() {
        // 1. Cập nhật con số trên thanh Header (DOM trực tiếp cho cực nhanh)
        let total = 0;
        this.items.forEach(qty => total += qty);
        const counterEl = document.getElementById('cart-counter');
        if (counterEl) counterEl.textContent = total;

        // 2. Kích hoạt Action tính lại tiền nếu Trang Giỏ Hàng đang mở (Cắm điện)
        if (window.MB && window.MB.nameToId.has('CartView')) {
            window.MB.callAction('CartView', 'calculateTotal');
        }
    }
};

// Phơi API ra Global để Engine có thể gọi qua tx.callJS
if (typeof window !== 'undefined') {
    window.CartStore = CartStore;
}