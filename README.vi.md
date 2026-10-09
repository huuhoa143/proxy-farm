# Proxy Farm

[English](README.md) · **Tiếng Việt**

[![License: MIT](https://img.shields.io/github/license/huuhoa143/proxy-farm)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/huuhoa143/proxy-farm?include_prereleases&sort=semver)](https://github.com/huuhoa143/proxy-farm/releases)
![Platforms: macOS | Windows](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows-lightgrey)

Proxy Farm là ứng dụng desktop biến gói VPN của chính bạn thành nhiều cổng proxy
SOCKS5/HTTP chạy ngay trên máy. Mỗi cổng là một tunnel độc lập, ghim vào một máy chủ VPN,
nên mỗi cổng có một IP lối ra riêng và ổn định.

![Màn hình chính của Proxy Farm](docs/screenshots/v2/main-server-pools-vi.png)

- **Chạy trên máy bạn.** Không Docker, không máy ảo, không cần quyền admin, không cần
  terminal. Proxy mặc định chỉ nghe trên `127.0.0.1`.
- **Dùng gói của chính bạn.** Proxy Farm không bán hay cung cấp VPN.
- **Không thu thập dữ liệu (telemetry).** Xem [PRIVACY.md](PRIVACY.md) để biết mọi kết nối
  mạng mà app thực hiện.

## Mục lục

- [Tính năng](#tính-năng)
- [Nhà cung cấp hỗ trợ](#nhà-cung-cấp-hỗ-trợ)
- [Cài đặt](#cài-đặt)
- [Bắt đầu nhanh](#bắt-đầu-nhanh)
- [Cách hoạt động](#cách-hoạt-động)
- [Build từ mã nguồn](#build-từ-mã-nguồn)
- [Hỗ trợ](#hỗ-trợ)
- [Bảo mật](#bảo-mật)
- [Quyền riêng tư](#quyền-riêng-tư)
- [Đóng góp](#đóng-góp)
- [Lưu ý pháp lý](#lưu-ý-pháp-lý)
- [Miễn trừ trách nhiệm](#miễn-trừ-trách-nhiệm)
- [Giấy phép](#giấy-phép)
- [v1 (Docker)](#v1-docker)

## Tính năng

- Một cổng = một máy chủ VPN = một IP lối ra. Một vị trí có nhiều máy chủ thì chạy được
  nhiều cổng, mỗi cổng một IP khác nhau.
- Mỗi cổng phục vụ **cả SOCKS5 lẫn HTTP** trên cùng một số cổng, có user/mật khẩu proxy
  sinh tự động ở lần chạy đầu.
- **Đổi IP** chuyển cổng sang một máy chủ còn trống của cùng vị trí và kiểm tra IP lối ra
  đã thật sự đổi. Có thể tự xoay theo chu kỳ N phút.
- **Giữ nguyên IP lối ra.** Cổng bị rớt sẽ thử lại đúng máy chủ cũ trước; chỉ chuyển sang
  máy khác khi máy đó được xác định là chết hoặc từ chối tài khoản của bạn.
- Trạng thái trực tiếp từng cổng (chờ lượt, đang kết nối, đang kiểm tra, online, chờ thử
  lại kèm đồng hồ đếm ngược và lý do, lỗi kèm hướng dẫn), IP lối ra, quốc gia, độ trễ.
- Kiểm tra từng cổng và đo tốc độ (tuỳ chọn); log từng cổng trong ngăn Chi tiết, đã che
  thông tin bí mật.
- Nhiều tài khoản cho mỗi nhà cung cấp; các cổng được chia đều giữa chúng.
- Thao tác hàng loạt, xuất danh sách 4 định dạng: `host:port:user:pass`,
  `socks5://user:pass@host:port`, `host:port`, `curl`.
- Webhook xoay IP (tuỳ chọn, mặc định tắt): `POST /rotate/<port-key>` kèm khoá Bearer.
- Biểu tượng khay hệ thống, tự mở khi đăng nhập (tuỳ chọn), giữ máy thức khi có cổng đang
  bật, tắt cổng khi máy ngủ và bật lại khi máy thức.
- Giao diện tiếng Anh và tiếng Việt, sáng/tối, cập nhật ngay trong app từ GitHub Releases.

## Nhà cung cấp hỗ trợ

| Nhà cung cấp | Giao thức | Bạn nhập gì | Ghi chú |
|---|---|---|---|
| **HMA** | OpenVPN | Không cần nhập: app đọc thông tin thiết bị từ app HMA cài trên cùng máy | Hiện chỉ macOS. Windows cần một dịch vụ trợ giúp chưa được làm. |
| **ZoogVPN** | OpenVPN | Email và mật khẩu tài khoản | Gói của bạn quyết định máy chủ nào cho vào; máy chủ từ chối sẽ được bỏ qua. |
| **Surfshark** | WireGuard | Private key WireGuard (trang thiết lập thủ công của Surfshark) | Danh sách máy chủ lấy từ API công khai của Surfshark. |
| **NordVPN** | WireGuard (NordLynx) | Mã truy cập (access token) từ Nord Account (NordVPN → Advanced settings → Get access token), hoặc private key NordLynx | Mã chỉ được dùng một lần để lấy khóa và không được giữ lại. Danh sách máy chủ lấy từ API công khai của NordVPN. |
| **ExpressVPN** | OpenVPN | Username và password ở trang Manual configuration → OpenVPN trong tài khoản ExpressVPN (không phải email/mật khẩu đăng nhập hay mã kích hoạt) | Được kiểm tra bằng một kết nối thử khi thêm. Danh sách máy chủ đóng gói sẵn (ExpressVPN không có danh sách công khai). Giới hạn mặc định 8 cổng: một gói cho 10 thiết bị. |
| **File cấu hình** | OpenVPN hoặc WireGuard | File `.ovpn` hoặc `.conf` WireGuard | Dùng được với nhà cung cấp khác hoặc máy chủ của riêng bạn, kể cả file `.ovpn` tải từ ExpressVPN. |

Có thể đặt giới hạn số cổng cho từng nhà cung cấp trong app. Chạy quá nhiều tunnel trên
một tài khoản có thể kích hoạt cơ chế chống lạm dụng của nhà cung cấp; xem
[Miễn trừ trách nhiệm](DISCLAIMER.md#tiếng-việt).

## Cài đặt

Tải bản mới nhất ở
[GitHub Releases](https://github.com/huuhoa143/proxy-farm/releases).

- **macOS 12 trở lên** (Apple silicon hoặc Intel): mở file `.dmg` rồi kéo Proxy Farm vào
  Applications. Hãy chạy app từ Applications, không chạy từ ổ đĩa ảnh, nếu không app
  không tự cập nhật được.
- **Windows (x64)**: chạy `Setup.exe`. Bản Windows **chưa được ký số**, nên SmartScreen sẽ
  cảnh báo: bấm *More info* → *Run anyway*. Bản Windows vẫn đang được kiểm chứng; gặp lỗi
  xin hãy báo lại.

## Bắt đầu nhanh

1. Mở Proxy Farm và chọn nhà cung cấp ở màn hình đầu tiên (HMA, ZoogVPN, Surfshark,
   NordVPN, ExpressVPN hoặc File cấu hình). Mỗi thẻ có mục "Cách lấy …" hướng dẫn từng
   bước. Với HMA: cài app HMA, đăng nhập và kết nối một lần; Proxy Farm sẽ tự
   lấy thông tin thiết bị.
2. Bấm **Thêm vị trí**, chọn các vị trí và số cổng cho mỗi vị trí.
3. Khi cổng hiện **Online**, dùng nó:

   ```bash
   curl -x socks5h://USER:PASS@127.0.0.1:29001 https://ipinfo.io
   curl -x http://USER:PASS@127.0.0.1:29001 https://ipinfo.io
   ```

   User và mật khẩu hiện ở mục **Đăng nhập proxy** trên màn hình chính.

Muốn dùng proxy từ thiết bị khác, bật **Chia sẻ trong mạng nội bộ** trong Cài đặt. Khi đó
các cổng nghe trên `0.0.0.0`; bắt buộc phải có user và mật khẩu proxy, và bạn nên đặt các
cổng sau tường lửa.

## Cách hoạt động

```
Proxy Farm (Electron)
  UI ── chỉ qua IPC ──► tiến trình chính: nhà cung cấp, pool máy chủ, health, lưu trữ
                             │ mỗi cổng một tiến trình, cấu hình qua stdin
                             ▼
  sing-box #1  127.0.0.1:29001 ──► máy chủ VPN A (IP lối ra A)
  sing-box #2  127.0.0.1:29002 ──► máy chủ VPN B (IP lối ra B)
```

- Mỗi cổng chạy một tiến trình [sing-box](https://github.com/SagerNet/sing-box) 1.14.2
  nguyên bản ở chế độ userspace: không TUN, không driver, không sửa bảng định tuyến.
- Đường ra duy nhất của một cổng là tunnel của nó. Tunnel chết thì proxy báo lỗi chứ không
  bao giờ đi thẳng bằng kết nối thật của bạn. DNS trong mỗi cổng đi bằng DoH tới `1.1.1.1`
  qua chính tunnel.
- Cấu hình, key và chứng chỉ được đưa cho sing-box qua stdin, không bao giờ ghi ra đĩa.
- Health được kiểm tra qua chính tunnel: thử kết nối mỗi 30 giây; kiểm tra IP lối ra và
  quốc gia sau mỗi lần khởi động, khi Đổi IP và khi bạn bấm kiểm tra cổng. Cổng lỗi thử
  lại với thời gian chờ tăng dần từ 30 giây tới 30 phút.

Tài liệu thiết kế:
[docs/superpowers/specs/2026-10-07-desktop-app-design.md](docs/superpowers/specs/2026-10-07-desktop-app-design.md)
(tiếng Anh).

## Build từ mã nguồn

Yêu cầu: Node.js 22 (≥ 22.22.2) hoặc 24 (≥ 24.15.0), và pnpm. Mọi lệnh chạy trong `app/`:

```bash
cd app
pnpm install
pnpm start           # tải sing-box, rồi chạy app ở chế độ phát triển
pnpm test            # unit test (vitest)
pnpm exec tsc --noEmit
pnpm make            # build bộ cài cho hệ điều hành hiện tại
```

`pnpm start`, `pnpm package` và `pnpm make` sẽ tải trước binary sing-box đã ghim phiên bản
cùng tarball mã nguồn của nó, kiểm tra sha256 theo `app/scripts/singbox.pins.json`. Sau
đó, `pnpm dev` chạy app mà không tải lại. Xem [CONTRIBUTING.md](CONTRIBUTING.md) (tiếng
Anh) để biết cấu trúc dự án.

## Hỗ trợ

Đặt câu hỏi ở [GitHub Discussions](https://github.com/huuhoa143/proxy-farm/discussions)
và báo lỗi ở [Issues](https://github.com/huuhoa143/proxy-farm/issues). Xem
[SUPPORT.md](SUPPORT.md) để biết cần gửi kèm gì và những gì tuyệt đối không được đăng.

## Bảo mật

Đừng báo lỗ hổng bảo mật trong issue công khai. Hãy dùng
[báo cáo lỗ hổng riêng tư](https://github.com/huuhoa143/proxy-farm/security/advisories/new).
Xem [SECURITY.md](SECURITY.md).

## Quyền riêng tư

Proxy Farm không thu thập gì, không có telemetry hay analytics. Cài đặt của bạn nằm trên
máy bạn, thông tin bí mật được mã hoá bằng kho khoá của hệ điều hành. App chỉ kết nối tới
máy chủ của nhà cung cấp VPN và một danh sách ngắn các dịch vụ được nêu rõ trong
[PRIVACY.md](PRIVACY.md).

## Đóng góp

Mọi đóng góp đều được chào đón. Hãy đọc [CONTRIBUTING.md](CONTRIBUTING.md) và
[Quy tắc ứng xử](CODE_OF_CONDUCT.md). Các thay đổi được ghi trong
[CHANGELOG.md](CHANGELOG.md).

## Lưu ý pháp lý

Công cụ này dùng **tài khoản VPN của chính bạn** trên **máy của chính bạn**. Nhà cung cấp
VPN thường **cấm chia sẻ hoặc bán lại** kết nối — đừng mở proxy ra internet hay chia cho
người khác. Bạn tự chịu trách nhiệm tuân thủ điều khoản dịch vụ của nhà cung cấp và luật
pháp nơi bạn sống. Kết nối lại dồn dập, chạy quá nhiều tunnel cùng lúc, hay chia sẻ kết nối
có thể khiến nhà cung cấp khoá tài khoản VPN của bạn.

Dự án không liên quan tới HMA, Gen Digital, Surfshark, ZoogVPN, NordVPN, Nord Security,
ExpressVPN hay bất kỳ nhà cung cấp VPN nào.

## Miễn trừ trách nhiệm

Phần mềm được cung cấp **"nguyên trạng" (AS IS), không kèm bất kỳ bảo đảm nào**. Bạn dùng
công cụ này **với rủi ro của chính mình**. Dự án không bảo đảm tính sẵn sàng, tốc độ, số
lượng IP, hay việc tương thích với bất kỳ nhà cung cấp nào, và các nhà cung cấp có thể thay
đổi hệ thống bất kỳ lúc nào. Các nhãn hiệu thuộc về chủ sở hữu tương ứng. Toàn văn ở
[DISCLAIMER.md](DISCLAIMER.md#tiếng-việt).

## Giấy phép

[MIT](LICENSE). Proxy Farm đi kèm sing-box (GPL-3.0-or-later) dưới dạng một chương trình
riêng, không chỉnh sửa, cùng các thành phần bên thứ ba khác; xem
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## v1 (Docker)

Phiên bản cũ chạy bằng Docker (manager, mỗi cổng một container, có IKEv2) được lưu trữ ở
tag [`v1-docker`](https://github.com/huuhoa143/proxy-farm/tree/v1-docker) và không còn
được phát triển.
