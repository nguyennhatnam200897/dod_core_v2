import { blueprint } from '../../engine/framework_v44.js';

export const HomeView = blueprint('HomeView', g => {
    // Kích hoạt Virtual Scroll khi trang được mount
    g.onInit(g.action({}, tx => {
        tx.callJS('initHomeVirtualScroll');
    }));

    // Bắt sự kiện Click nút Thêm vào giỏ hàng
    const addAction = g.action(
        { productId: g.i32 },
        (tx, { productId }) => {
            // Chuyển tín hiệu từ WebAssembly sang JS Store
            tx.callJS('CartStore.add', productId);
        }
    );
    g.onClick('.btn-add', addAction, { productId: "dataset.id" });
});