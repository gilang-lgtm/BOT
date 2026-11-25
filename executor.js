// Pelaksana order. Saat ini hanya mode "paper" (simulasi): tidak ada uang dan tidak ada broker.
//
// Untuk akun broker sungguhan, konektor baru (mis. MetaTrader 5 atau MetaApi) cukup menambah
// satu objek di sini dengan method open(row) yang mengirim order dan mengembalikan { note }.
// Konektor sengaja BELUM ada: tambahkan setelah punya akun, dan uji dulu di akun demo.

const paper = {
  name: "simulasi",
  async open(row) {
    return { note: "dicatat sebagai order SIMULASI (tidak ada uang/broker yang terlibat)" };
  },
};

export function makeExecutor(mode) {
  if (mode === "paper") return paper;
  throw new Error(`EXECUTION="${mode}" belum tersedia. Saat ini hanya EXECUTION=paper (simulasi).`);
}
