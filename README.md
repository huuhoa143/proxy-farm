# Proxy Farm

Biến tài khoản VPN của bạn thành hàng chục cổng proxy **SOCKS5 + HTTP** độc lập, chạy
ngay trên máy bạn — mỗi cổng một quốc gia/thành phố với IP lối ra riêng, quản lý bằng
giao diện web.

![Proxy Farm](docs/screenshot.png)

- **Chạy local.** Không cần VPS, không mở cổng ra internet; UI và proxy mặc định chỉ
  nghe trên `127.0.0.1`.
- **Nhiều nhà cung cấp.** HMA (IKEv2 + chứng chỉ), WireGuard, OpenVPN, IKEv2 user/mật khẩu
  — trộn trong cùng một farm.
- **Tự phục hồi.** Mỗi cổng có kill-switch, watchdog và tự thử lại cho tới khi kết nối
  được; UI cho thấy từng bước đang làm.

## Mục lục

- [Tính năng](#tính-năng)
- [Nhà cung cấp hỗ trợ](#nhà-cung-cấp-hỗ-trợ)
- [Yêu cầu](#yêu-cầu)
- [Cài đặt nhanh](#cài-đặt-nhanh)
- [Sử dụng](#sử-dụng)
- [Cấu hình](#cấu-hình)
- [Cách hoạt động](#cách-hoạt-động)
- [Giới hạn đã biết](#giới-hạn-đã-biết)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Đóng góp](#đóng-góp)
- [Lưu ý pháp lý](#lưu-ý-pháp-lý)
- [Giấy phép](#giấy-phép)

## Tính năng

- Mỗi vị trí là một cổng phục vụ **cả SOCKS5 lẫn HTTP**, có user/mật khẩu sinh tự động
- **Kill-switch** trong từng cổng: tunnel chết thì proxy đóng, không bao giờ rò IP thật
- **Trạng thái trực tiếp**: *Chờ lượt → Đang bắt tay → Chờ dữ liệu → Online*, hoặc
  *Chờ thử lại* với đồng hồ đếm ngược, lý do thất bại, số lần thử và thời gian đã thử
- **Kiểm tra proxy ngay trên UI**: IP lối ra, nhà mạng, quốc gia có khớp không, độ trễ,
  thời gian TLS, tốc độ tải; kèm lệnh `curl` để chép
- Thao tác hàng loạt: bật / tắt / xoay IP / tự xoay theo lịch / xuất / xoá
- **Xuất danh sách** 4 định dạng: `host:port:user:pass`, `socks5://user:pass@host:port`,
  `host:port`, lệnh `curl`
- **Webhook xoay IP** cho hệ thống khác gọi
- Giới hạn số cổng theo từng nhà cung cấp (tuỳ chọn)
- Xem log từng cổng, dark/light, responsive (trên mobile bảng chuyển thành thẻ)
- CLI cho mọi thao tác

## Nhà cung cấp hỗ trợ

| Nguồn | Giao thức | Nạp thế nào | Trạng thái |
|---|---|---|---|
| **HMA / SurfEasy / Gen Digital** | IKEv2 + chứng chỉ client | tự lấy từ app HMA trên máy, rồi chọn trong 115 thành phố | đã kiểm chứng |
| **Mullvad, Proton, Surfshark, IVPN, Windscribe, PIA…** | WireGuard | kéo thả file `.conf` | đã kiểm chứng |
| Máy chủ WireGuard của bạn (VPS) | WireGuard | kéo thả file `.conf` | đã kiểm chứng |
| Nhà cung cấp OpenVPN | OpenVPN | kéo thả file `.ovpn` | chưa kiểm chứng |
| Nhà cung cấp IKEv2 user/mật khẩu (NordVPN, Proton…) | IKEv2 + EAP-MSCHAPv2 | form trong UI | chưa kiểm chứng |

Một file cấu hình = một vị trí = một cổng proxy.

## Yêu cầu

- **Docker** với Docker Compose v2. Trên macOS/Windows dùng Docker Desktop — kernel
  LinuxKit của nó có sẵn IPsec/xfrm và WireGuard (đã kiểm chứng trên Apple Silicon).
- Một tài khoản VPN của chính bạn. Với HMA: app HMA đã đăng nhập trên cùng máy (macOS).

## Cài đặt nhanh

```bash
git clone <repo-url> proxy-farm && cd proxy-farm
./run.sh
```

Mở **http://127.0.0.1:8090**. Nếu app HMA có trên máy, chứng chỉ được nạp tự động; vào
**Thêm vị trí**, chọn nơi muốn chạy rồi bấm **Bật**.

`./run.sh` tạo thư mục dữ liệu (mặc định `~/proxy-farm`), ghi `.env`, build hai image và
chạy manager bằng Docker Compose. Lần sau có thể dùng Compose trực tiếp:

```bash
docker compose up -d                  # chạy / cập nhật manager
docker compose down                   # dừng manager (các cổng proxy vẫn chạy)
docker compose build node manager     # build lại image sau khi sửa code
```

## Sử dụng

### Nạp nhà cung cấp

`./run.sh` tự làm phần lớn việc:

- **HMA** — nếu app HMA có trên máy, script copy `tokenCoreSE.json` vào `$FARM/inbox` và
  manager tự cài chứng chỉ. Chạy lại `run.sh` là đồng bộ lại.
- **File cấu hình** — thả `.conf` / `.ovpn` vào `$FARM/inbox`, tự nạp trong vòng một phút.
- **Gợi ý** — thư mục `~/Downloads` được mount **chỉ-đọc**; UI liệt kê các `.conf`/`.ovpn`
  chưa nạp để bạn bấm *Nạp*, không bao giờ tự nạp.

Không tự động được thì mở **Nhà cung cấp** ở thanh bên trái:

| Nhà cung cấp | Làm gì |
|---|---|
| **HMA** | Kéo thả `tokenCoreSE.json` (macOS: `/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json`), hoặc file `.p12` kèm mật khẩu. |
| **WireGuard / OpenVPN** | Kéo thả `.conf` / `.ovpn`. Nhà cung cấp và quốc gia đoán từ tên file. |
| **IKEv2 user/mật khẩu** | Điền máy chủ + tài khoản. Mỗi máy chủ thành một vị trí. |

### Dùng proxy

```bash
curl -x socks5h://USER:PASS@127.0.0.1:29001 https://ipinfo.io
curl -x http://USER:PASS@127.0.0.1:29001   https://ipinfo.io
```

Trong app khác: loại **SOCKS5** (hoặc HTTP), host `127.0.0.1`, port theo cột *Điểm cuối*,
user/mật khẩu hiện ở đầu trang.

### Bật, tắt và trạng thái

- **Bật** một cổng: tạo container mới từ image mới nhất. **Tắt**: đóng phiên VPN, xoá
  container, giữ lại số cổng. Thanh lọc *Đang bật / Đã tắt / Tất cả* tách hai nhóm.
- Cổng đang bật mà chưa lên thì **tự thử cho tới khi kết nối được**, không bao giờ tự bỏ.
  Rê chuột vào cột trạng thái để xem nó đang làm gì và vì sao lần trước thất bại.
- Nút ⚡ (hoặc chọn nhiều dòng → *Kiểm tra*, tối đa 20) chạy thử thật qua cổng đó.

### Giới hạn số cổng

Mặc định HMA **không giới hạn** (đã chạy 27+ cổng cùng lúc). Với nhà cung cấp chỉ cho một
số kết nối cùng lúc, bật công tắc *Giới hạn* trong thẻ nhà cung cấp và nhập số tối đa;
farm sẽ từ chối bật quá số đó. Giá trị gợi ý: ProtonVPN/NordVPN 10, ExpressVPN 8,
CyberGhost 7, Mullvad 5.

### Webhook xoay IP

```
GET http://127.0.0.1:8090/api/rotate?key=<rotate_key>&port=29001
GET http://127.0.0.1:8090/api/rotate?key=<rotate_key>&all=1
```

`rotate_key` xem và đổi trong **Cài đặt**.

### CLI

```bash
docker exec pf-manager python3 farm.py up US JP DE-16-BERLIN   # mã nước / key / all
docker exec pf-manager python3 farm.py ls
docker exec pf-manager python3 farm.py rotate US-NY-NEW-YORK
docker exec pf-manager python3 farm.py stop|start|down <KEY..>
docker exec pf-manager python3 farm.py autorotate <KEY..> 30
docker exec pf-manager python3 farm.py logs <KEY>
```

## Cấu hình

Biến cho `./run.sh` (được ghi vào `.env`, lần sau không cần nhắc lại):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `FARM` | `~/proxy-farm` | Thư mục dữ liệu: chứng chỉ, cấu hình, trạng thái. Không nằm trong repo. |
| `PORT` | `8090` | Cổng UI, chỉ trên `127.0.0.1`. |
| `BIND` | `127.0.0.1` | Địa chỉ các cổng proxy lắng nghe. Đặt IP LAN/Tailscale nếu máy khác cần dùng. |
| `SCAN` | `~/Downloads` | Thư mục quét gợi ý file cấu hình (chỉ-đọc). Để trống là tắt. |

Trong UI (**Cài đặt**): user/mật khẩu proxy, địa chỉ lắng nghe, cổng bắt đầu, MTU, DNS
trong tunnel, ngưỡng watchdog, khoá webhook. Thay đổi nằm trong `docker run` của từng
cổng chỉ có hiệu lực sau khi dựng lại — nút *Lưu & dựng lại* làm việc đó.

## Cách hoạt động

```
                    Docker trên máy bạn
  ┌──────────────────────────────────────────────────────────────┐
  │  pf-manager   ── UI :8090 ──  điều khiển qua docker.sock      │
  │      │ docker run                                             │
  │      ▼                                                        │
  │  pf-<vị-trí>    (1 container / cổng)                         │
  │    drivers/<protocol>.sh ══► máy chủ VPN của nhà cung cấp     │
  │    gost SOCKS5+HTTP trên :1080 → publish 127.0.0.1:290NN      │
  │    kill-switch · DoH · watchdog tự phục hồi                   │
  └──────────────────────────────────────────────────────────────┘
      127.0.0.1:29001 → US New York
      127.0.0.1:29002 → JP Tokyo   ...
```

Mỗi cổng là một container riêng vì mỗi tunnel cần network namespace, bảng định tuyến và
kill-switch riêng. Các container nằm chung nhóm `proxy-farm` trong Docker Desktop.

Trong mỗi container:

- **kill-switch** — bỏ default route; chỉ gói của chính tunnel và dải private đi mạng
  thật. Tunnel chết ⇒ proxy fail closed.
- **DoH** — gost phân giải tên miền qua `https://1.1.1.1/dns-query`, vì vài máy chủ chặn
  UDP 53.
- **watchdog** — mỗi 15 giây tải thật qua chính proxy; lỗi 3 lần liên tiếp ⇒ đóng phiên,
  thoát, Docker khởi động lại và kết nối lại.
- **cổng nguồn ngẫu nhiên** — mỗi lần kết nối, cổng IKE 500/4500 được đổi sang một cặp
  cổng mới, để không bao giờ dính lại một luồng mạng đã hỏng.

`node/entrypoint.sh` lo phần dùng chung; phần riêng của từng giao thức nằm trong
`node/drivers/<protocol>.sh`. Xem [Đóng góp](#đóng-góp) để thêm giao thức.

### Vì sao HMA dùng được dù app không cho tải file cấu hình

HMA chạy trên hạ tầng **SurfEasy / Gen Digital**. App xác thực bằng **chứng chỉ client
(PKCS#12)** qua IKEv2 tới `*.ult.surfeasy.mobi` (74 nước / 115 thành phố). Farm lấy chứng
chỉ đó từ app rồi kết nối IKEv2 bằng **libreswan** — đúng giao thức app dùng. Hai điểm
không hiển nhiên:

1. Máy chủ trả về IDr (`ipsec.surfeasy.mobi`) **không khớp SAN** trong chính chứng chỉ của
   nó. strongSwan từ chối; libreswan với `require-id-on-certificate=no` chấp nhận (giống
   client IKEv2 của Apple).
2. Phải **đặt MTU** (`mtu=1400`). Thiếu nó thì bắt tay TCP vẫn xong nhưng gói lớn đầu
   tiên (TLS ClientHello) bị rớt âm thầm và mọi kết nối treo.

<details>
<summary>Trích chứng chỉ bằng tay (UI đã làm hộ)</summary>

`tokenCoreSE.json` chứa `DeviceManager.device` (base64 của JSON); trong đó
`credentials.certificate` là PKCS#12 dạng base64 và `credentials.certificatePassword` là
mật khẩu của nó.

```bash
openssl pkcs12 -in client.p12 -passin pass:<pass> -nokeys -clcerts -out client.pem
openssl pkcs12 -in client.p12 -passin pass:<pass> -nocerts -nodes  -out client.key
openssl pkcs12 -in client.p12 -passin pass:<pass> -nokeys -cacerts -out ca-int.pem
```

Thêm `-legacy` nếu OpenSSL 3 báo lỗi thuật toán cũ. Hai CA trung gian công khai mà máy chủ
không gửi kèm đã nằm sẵn trong image (`node/ca/`).
</details>

## Giới hạn đã biết

- **Bắt tay xong nhưng không có dữ liệu** — hành vi của chính HMA (app chính chủ cũng báo
  *Connected* mà không nhận về gói nào). Node phát hiện sau ~20 giây, đóng phiên và thử
  lại; lần sau thường chạy được. Bật 27 cổng cùng lúc: ~15 lên ngay, 25/27 sau ~7 phút.
- **Một số cụm máy chủ điều phối của HMA rớt gói** (đo được ở cụm Frankfurt: 30–60% lần
  thử được trả lời). Node tự thử lại.
- **HMA cắt mỗi phiên sau ~4,5 giờ.** Node nối lại sau vài giây; IP lối ra có thể đổi.
- **Máy ngủ thì mọi tunnel chết.** Để chạy liên tục, cắm sạc và đặt máy không ngủ khi
  cắm sạc; gập máy vẫn ngủ.
- **Đừng bật app HMA trên máy đang chạy farm** — app đưa toàn bộ mạng của máy vào VPN và
  các tunnel của farm rớt theo.
- Không chạy farm trên hai máy cùng lúc với cùng một chứng chỉ.
- Driver `openvpn` và `ikev2-eap` viết theo tài liệu nhưng chưa được kiểm chứng.

## Xử lý sự cố

| Triệu chứng | Làm gì |
|---|---|
| Cổng *Chờ thử lại · không có dữ liệu* | Lỗi phía nhà cung cấp; cứ để farm tự thử, hoặc bấm *Đổi IP* để thử ngay. |
| Cổng *Chờ thử lại · không trả lời* | Máy chủ điều phối không trả lời; farm tự thử lại và đổi sang IP khác của vị trí. |
| Tất cả cổng rớt cùng lúc | Máy vừa ngủ hoặc Docker vừa khởi động lại; các cổng tự lên lại trong vài phút. |
| Docker Desktop báo `Internal Server Error` | Máy ảo Docker bị treo: thoát và mở lại Docker Desktop. |
| Xem chi tiết một cổng | Nút log trên dòng đó, hoặc `docker logs pf-<vị-trí>`. |

## Đóng góp

Pull request và issue đều được chào đón.

**Thêm một giao thức** = thêm file `node/drivers/<protocol>.sh` định nghĩa các hàm:

| Hàm | Bắt buộc | Việc |
|---|---|---|
| `driver_resolve` | có | In ra các IP điểm cuối (mỗi dòng một IP) để ghim route |
| `driver_up` | có | Dựng tunnel |
| `driver_outer` | không | Thêm `ip rule` cho gói của chính tunnel |
| `driver_established` | không | Trả về 0 khi tunnel đã dựng (để UI hiện *Chờ dữ liệu*) |
| `driver_stuck` | không | Trả về 0 khi chắc chắn lần thử này hỏng, để bỏ sớm |
| `driver_down` | không | Đóng phiên sạch sẽ khi dừng |

Rồi thêm nhận dạng file cấu hình trong `manager/farm.py` (`detect_protocol`) nếu cần.

Trước khi gửi PR: chạy `sh -n node/entrypoint.sh node/drivers/*.sh` và
`python3 -m py_compile manager/farm.py`, rồi thử thật bằng `./run.sh`.
**Không bao giờ commit** chứng chỉ, file cấu hình VPN, `.env` hay thư mục dữ liệu.

## Lưu ý pháp lý

Công cụ này dùng **tài khoản VPN của chính bạn** trên **máy của chính bạn**. Nhà cung cấp
VPN thường **cấm chia sẻ hoặc bán lại** kết nối — đừng mở proxy ra internet hay chia cho
người khác. Bạn tự chịu trách nhiệm tuân thủ điều khoản dịch vụ của nhà cung cấp và luật
pháp nơi bạn sống. Dự án không liên quan tới HMA, SurfEasy, Gen Digital hay bất kỳ nhà cung
cấp VPN nào.

## Giấy phép

[MIT](LICENSE). Các thành phần đi kèm trong image (libreswan, gost, WireGuard tools,
OpenVPN) theo giấy phép riêng của chúng.
