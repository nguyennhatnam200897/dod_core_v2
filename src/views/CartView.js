import { blueprint } from '../../engine/framework_v44.js';

export const CartView = blueprint('CartView', g => {
    const totalMoney = g.state(g.f64, 0);
    g.bindText('.total-price', totalMoney);

    // Action này được JS Store gọi mỗi khi giỏ hàng có sự thay đổi
    const calcAction = g.action({}, tx => {
        tx.callJS('renderCartListAndCalculate');
    });
    
    g.onInit(calcAction);
    g.exportAction('calculateTotal', calcAction);
});