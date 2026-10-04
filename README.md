# Proxy Farm

Biến tài khoản VPN của bạn thành hàng chục cổng proxy **SOCKS5 + HTTP** độc lập, chạy
ngay trên máy bạn — mỗi cổng một quốc gia/thành phố với IP lối ra riêng, quản lý bằng
giao diện web.

![Proxy Farm](docs/screenshot.png)

- **Chạy local.** Không cần VPS, không mở cổng ra internet; UI và proxy mặc định chỉ
  nghe trên `127.0.0.1`.
- **Nhiều nhà cung cấp.** Surfshark và ZoogVPN chỉ cần nhập key / tài khoản, HMA lấy từ
  app, cộng với mọi file WireGuard / OpenVPN — trộn trong cùng một farm.
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

| Nguồn | Giao thức | Bạn nhập gì | Vị trí | Giới hạn mỗi tài khoản |
|---|---|---|---|---|
| **Surfshark** | WireGuard | 1 private key | 180 (100 nước, gồm 38 IP tĩnh) | không — đã chạy 26 cổng trên một key |
| **ZoogVPN** | IKEv2 + EAP | email + mật khẩu | 165 (75 nước) | không giới hạn số kết nối (đã chạy 6); **gói quyết định máy chủ nào được dùng** — gói thử: 29/165 |
| **HMA / SurfEasy / Gen Digital** | IKEv2 + chứng chỉ client | tự lấy từ app HMA trên máy | 115 thành phố | không — đã chạy 27+ cổng |
| Mullvad, Proton, IVPN, Windscribe, PIA… | WireGuard | kéo thả file `.conf` | 1 file = 1 vị trí | đã kiểm chứng |
| Máy chủ WireGuard của bạn (VPS) | WireGuard | kéo thả file `.conf` | 1 file = 1 vị trí | đã kiểm chứng |
| Nhà cung cấp IKEv2 user/mật khẩu khác (NordVPN…) | IKEv2 + EAP | máy chủ + tài khoản | 1 máy chủ = 1 vị trí | driver đã kiểm chứng qua ZoogVPN |
| Nhà cung cấp OpenVPN | OpenVPN | kéo thả file `.ovpn` | 1 file = 1 vị trí | chưa kiểm chứng |

Vị trí **ảo** (Surfshark và ZoogVPN đều có) mang IP của quốc gia đó nhưng máy chủ đặt ở
nước khác; UI gắn nhãn *ảo* để bạn biết.

### Nhiều tài khoản cho cùng một nhà

Mỗi nhà có sẵn là một **pool**: thêm bao nhiêu tài khoản cũng được, danh sách vị trí vẫn
hiện **một lần**. Khi bạn bật một cổng, farm tự gán nó vào tài khoản đang rảnh nhất.

Thêm tài khoản là thêm **sức chứa** và **độ phủ**, không phải thêm vị trí. Cả ba nhà có
sẵn đều không giới hạn số kết nối, nên thường một tài khoản đã đủ. Tài khoản thứ hai có
ích khi gói của tài khoản đầu không phủ hết máy chủ (ZoogVPN), hoặc để tách luồng.

Farm tự xử lý khi có sự cố:

| Nhà cung cấp báo | Farm làm gì |
|---|---|
| đúng mật khẩu nhưng từ chối máy chủ này | ghi nhớ *(tài khoản, máy chủ)* trong 7 ngày, chuyển cổng sang tài khoản khác; không tài khoản nào dùng được thì máy chủ mang nhãn *gói không hỗ trợ* |
| sai tài khoản | đánh dấu tài khoản lỗi, ngừng gán cổng cho nó |
| bạn xoá một tài khoản | cổng chuyển sang tài khoản còn chỗ; hết chỗ mới tắt |

### Tối đa bao nhiêu cổng

Hai trần, chạm trần nào trước thì dừng ở đó:

1. **Máy chủ gói của bạn được dùng** — chỉ ZoogVPN hạn chế (gói thử dùng được 29/165).
2. **Số máy chủ ở nước đó** — một máy chủ chạy một cổng, nên trần này **phụ thuộc quốc gia**:

| Nước | Surfshark | ZoogVPN | HMA | Tối đa |
|---|---|---|---|---|
| Mỹ | 29 | 10 | 25 | **64** |
| Nhật | 13 | 9 | 1 | **23** |
| Đức | 9 | 7 | 4 | **20** |
| Anh | 9 | 3 | 5 | **17** |
| Singapore | 7 | 3 | 1 | **11** |
| Việt Nam | 1 | 2 | 1 | **4** |

Cộng cả ba nhà: **460 vị trí / 109 nước**. 23 nước chỉ có đúng một máy chủ.

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

Mở **Nhà cung cấp** ở thanh bên trái. Phần *Thêm tài khoản* liệt kê từng nền tảng kèm
**cần gì** và **các bước lấy thông tin đó**, nên không phải tra tài liệu ở đâu khác:

| Nhà cung cấp | Làm gì |
|---|---|
| **Surfshark** | Dán private key WireGuard. Farm tự tải danh sách máy chủ và sinh cấu hình cho từng vị trí. |
| **ZoogVPN** | Nhập email và mật khẩu của app. |
| **HMA** | Nhập **activation code** (wallet key) để xác thực gói off-device, rồi nạp chứng chỉ thiết bị **một lần** (`tokenCoreSE.json` — macOS: `/Library/Application Support/HMA VPN/state/vpn/tokenCoreSE.json`, hoặc `.p12` kèm mật khẩu). Sau đó chạy đa nền tảng, không cần app. |
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

Giới hạn đặt theo **từng tài khoản**, trong thẻ nhà cung cấp, và chỉ bạn đặt — farm không
tự đoán: một lần bị từ chối chưa đủ chứng minh có trần (xem ZoogVPN bên dưới). Với nhà cung cấp chỉ cho một số kết nối cùng lúc, bật công tắc *Giới hạn* trong thẻ nhà cung cấp và nhập số tối đa;
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

Nhà cung cấp có sẵn (Surfshark, ZoogVPN) là plugin trong `manager/vendors.py`: mỗi plugin
khai báo form cần nhập, cách kiểm tra, và cách biến một tài khoản thành danh sách vị trí.

### Surfshark: một key, mọi máy chủ

Surfshark công khai danh sách máy chủ kèm public key WireGuard của từng máy
(`api.surfshark.com/v4/server/clusters`). Private key của bạn được đăng ký với tài khoản,
không gắn với máy chủ nào, nên farm ghép nó với public key của từng máy để sinh cấu hình
ngay lúc bật cổng (`$FARM/configs/.gen/`). Danh sách tự làm mới mỗi 12 giờ.

### ZoogVPN: IKEv2 bằng tài khoản

ZoogVPN không công khai danh sách máy chủ; `manager/catalogs/zoogvpn.json` được dựng bằng
`tools/zoogvpn-catalog.py` (dò tên `<nước><số>.zoogvpn.com` / `.webunlim.com` trong DNS
rồi hỏi từng máy chứng chỉ của nó — không dùng tài khoản nào). Kết nối dùng **strongSwan**
vì libreswan không có EAP-MSCHAPv2. Nhiều máy `*.webunlim.com` chạy chứng chỉ **đã hết
hạn**: farm chỉ chấp nhận khi chuỗi chứng chỉ vẫn hợp lệ ngoài ngày tháng và đúng tên máy,
rồi **ghim khoá công khai** (`$FARM/status/pins/`) — lần sau khoá khác là từ chối.

**Không giới hạn số kết nối, nhưng gói chọn máy chủ.** Đã chạy 6 cổng cùng lúc trên một
tài khoản. Máy chủ ngoài gói luôn từ chối, bất kể đang chạy mấy cổng, theo một trong hai
cách: `EAP_FAILURE` (mật khẩu đúng, không cho vào) hoặc `AUTHENTICATION_FAILED` ngay trước
EAP. Quét đủ 165 máy bằng tài khoản thử: 29 dùng được, 124 ngoài gói, 12 không trả lời.

**MTU theo cả hai chiều.** IPsec theo policy đi qua `eth0` (MTU 1500), nên kernel cắt
gói gửi đi theo 1500 và mỗi gói đầy thành một gói ESP bị phân mảnh. Nhiều máy chủ (HK, DE,
ES, MY…) bỏ mảnh: bắt tay xong, request nhỏ chạy, còn upload hay TLS ClientHello thì treo.
Kẹp MSS trên SYN chỉ lo chiều về; chiều đi do `kernel-netlink { mtu, mss }` đặt trên route
mà charon cài.

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

### Onboarding bằng activation code (đa nền tảng)

Mục tiêu: người dùng chỉ **nhập activation code**, không cài app HMA. Luồng hai bước:

```bash
# 1) Xác thực code — hoàn toàn off-device, mọi nền tảng, chỉ cần stdlib Python.
python3 manager/farm.py validate-code XXXXXX-XXXXXX-XXXXXX
#   ✓ HMA Pro VPN - 1 user, 3 years · hết hạn 2026-12-05 · thiết bị 0/5 · license <license-id>…

# 2a) Trích chứng chỉ thiết bị MỘT lần, trên một máy macOS có app HMA:
sudo bash tools/hma-bootstrap-cert.sh XXXXXX-XXXXXX-XXXXXX ./hma-bootstrap

# 2b) Nạp vào farm (chạy được trên Linux/minipc, không cần app nữa):
python3 manager/farm.py onboard-code XXXXXX-XXXXXX-XXXXXX ./hma-bootstrap/tokenCoreSE.json
# hoặc: ... onboard-code <CODE> ./hma-bootstrap/device.p12 <p12-password>
```

Code được lưu cùng tài khoản (`providers.json`), nên farm luôn biết gói nào, hạn khi nào,
còn mấy slot thiết bị — và tài khoản được nhận diện bằng đúng chuỗi người dùng đã gõ.
Trong UI: **Nhà cung cấp → HMA**, nhập code, bấm **Kiểm tra**, rồi thả chứng chỉ.

#### Bức tường activation-code → chứng chỉ

Việc xác thực code chạy off-device (Avast licensing API). Nhưng **cấp chứng chỉ thiết bị
từ code thì không** làm off-device thuần được: HMA phát hành PKCS#12 qua luồng *connect
token* (CCT) riêng của Avast — một bus message protobuf tới `*.ff.avast.com` cộng một POST
**ký AWS SigV4** tới `api.se-platform.com/passage/v6/devices`. Không cái nào có schema công
khai, và app desktop cache chứng chỉ ở ba nơi (system keychain, login keychain, token
files) nên không thể ép onboard lại để bắt gói nếu không reset sạch toàn bộ app. Vì vậy
chứng chỉ được trích **một lần** (bước 2a); sau đó nó dùng được tới khi gói hết hạn, trên
mọi nền tảng. Phá bức tường này (onboard bất kỳ code nào, không cần máy có app) cần hoặc
một lần capture phá hoại, hoặc dựng lại schema protobuf CCT — ghi chú để làm sau.

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
- Driver `openvpn` viết theo tài liệu nhưng chưa được kiểm chứng.
- Danh sách máy chủ ZoogVPN là ảnh chụp; chạy lại `tools/zoogvpn-catalog.py` khi họ đổi máy chủ.
- Nhãn *gói không hỗ trợ* hết hạn sau 7 ngày; khi đó farm thử lại máy chủ đó một lần.

## Xử lý sự cố

| Triệu chứng | Làm gì |
|---|---|
| Cổng *Chờ thử lại · không có dữ liệu* | Lỗi phía nhà cung cấp; cứ để farm tự thử, hoặc bấm *Đổi IP* để thử ngay. |
| Vị trí mang nhãn *gói không hỗ trợ* | Gói của mọi tài khoản bạn đã thêm đều không cho dùng máy chủ đó; thêm tài khoản gói cao hơn hoặc chọn máy khác cùng nước. |
| Cổng *Chờ thử lại · không bắt tay* (WireGuard) | Key sai, đã bị thu hồi, hoặc tài khoản hết gói. |
| Cổng *Chờ thử lại · sai tài khoản* | Kiểm tra lại email / mật khẩu. |
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

**Thêm một nhà cung cấp có sẵn** (người dùng chỉ nhập tài khoản) = thêm một mục vào
`VENDORS` trong `manager/vendors.py`. Không phải sửa `farm.py` hay UI.

| Khoá | Việc |
|---|---|
| `setup` | `needs` (một dòng), `steps` (các bước lấy thông tin), `link` — UI tự vẽ phần hướng dẫn |
| `fields` | các ô cần nhập — UI tự vẽ form |
| `check` | kiểm tra dữ liệu nhập → `(dữ liệu lưu, nhãn hiển thị)` |
| `targets` | danh sách vị trí của nhà đó, **không phụ thuộc tài khoản** |
| `bind` | cổng này cần gì từ tài khoản: `env`, `config_text`, hoặc `secrets` |

Trước khi gửi PR: chạy `sh -n node/entrypoint.sh node/drivers/*.sh` và
`python3 -m py_compile manager/farm.py manager/vendors.py`, rồi thử thật bằng `./run.sh`.
**Không bao giờ commit** chứng chỉ, file cấu hình VPN, `.env` hay thư mục dữ liệu.

## Lưu ý pháp lý

Công cụ này dùng **tài khoản VPN của chính bạn** trên **máy của chính bạn**. Nhà cung cấp
VPN thường **cấm chia sẻ hoặc bán lại** kết nối — đừng mở proxy ra internet hay chia cho
người khác. Bạn tự chịu trách nhiệm tuân thủ điều khoản dịch vụ của nhà cung cấp và luật
pháp nơi bạn sống. Dự án không liên quan tới HMA, SurfEasy, Gen Digital, Surfshark, ZoogVPN
hay bất kỳ nhà cung cấp VPN nào.

## Giấy phép

[MIT](LICENSE). Các thành phần đi kèm trong image (libreswan, gost, WireGuard tools,
OpenVPN) theo giấy phép riêng của chúng.
