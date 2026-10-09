export type Lang = 'vi' | 'en';

type Faq = { q: string; a: string };
type Step = { title: string; body: string; alt: string };
type FeatureRow = { title: string; body: string; next?: boolean };
type Provider = { name: string; key: string; signIn: string; protocol: string; next?: boolean; note?: string };
type UseCase = { who: string; body: string; example: [string, string] };

export interface Copy {
  htmlLang: string;
  ogLocale: string;
  meta: { title: string; description: string; ogAlt: string };
  skip: string;
  nav: { how: string; features: string; screens: string; faq: string; download: string; menu: string };
  langSwitch: { label: string; other: string; otherShort: string };
  hero: {
    title: string;
    titleSub: string;
    lede: string;
    download: string;
    soon: string;
    platforms: string;
    watch: string;
    github: string;
    facts: string[];
  };
  board: {
    label: string;
    caption: string;
    ports: string;
    servers: string;
    changeIp: string;
    changeIpFor: (port: string) => string;
    noFree: string;
    moved: (port: string, ip: string) => string;
    free: string;
    exit: string;
  };
  demo: { title: string; body: string; pending: string; pendingNote: string; transcript: string };
  how: { title: string; lede: string; steps: Step[] };
  features: {
    title: string;
    lede: string;
    nextTag: string;
    groups: { title: string; rows: FeatureRow[] }[];
  };
  providers: {
    title: string;
    lede: string;
    cols: { provider: string; signIn: string; protocol: string };
    list: Provider[];
    footnote: string;
  };
  screens: { title: string; lede: string; light: string; dark: string; altMain: string; altPools: string; poolsCaption: string; real: string };
  useCases: { title: string; list: UseCase[] };
  download: {
    title: string;
    lede: string;
    targets: Record<'mac-arm64' | 'mac-x64' | 'win-x64', { name: string; detail: string }>;
    soon: string;
    get: string;
    releases: string;
    build: string;
  };
  faq: { title: string; list: Faq[] };
  support: { title: string; lede: string; discussions: string; discussionsBody: string; issues: string; issuesBody: string; security: string; securityBody: string };
  footer: {
    by: string;
    privacy: string;
    disclaimer: string;
    license: string;
    changelog: string;
    notice: string;
    trademarks: string;
  };
}

const vi: Copy = {
  htmlLang: 'vi',
  ogLocale: 'vi_VN',
  meta: {
    title: 'Proxy Farm: biến gói VPN của bạn thành proxy SOCKS5/HTTP',
    description:
      'Ứng dụng miễn phí, mã nguồn mở biến gói VPN của bạn thành nhiều proxy SOCKS5/HTTP trên máy, mỗi cổng một IP cố định. Không Docker, không cần admin.',
    ogAlt: 'Proxy Farm: mỗi cổng proxy trên máy bạn nối với một máy chủ VPN, một IP cố định',
  },
  skip: 'Bỏ qua, đến nội dung chính',
  nav: { how: 'Cách hoạt động', features: 'Tính năng', screens: 'Ảnh màn hình', faq: 'Hỏi đáp', download: 'Tải về', menu: 'Mục lục' },
  langSwitch: { label: 'Ngôn ngữ', other: 'English', otherShort: 'EN' },
  hero: {
    title: 'Biến gói VPN của bạn thành hàng chục proxy.',
    titleSub: 'Mỗi cổng một IP cố định.',
    lede:
      'Proxy Farm chạy trên máy bạn và mở các cổng SOCKS5/HTTP cục bộ. Mỗi cổng là một đường hầm riêng tới đúng một máy chủ VPN. Không cần Docker, terminal hay quyền admin.',
    download: 'Tải về',
    soon: 'Sắp ra mắt',
    platforms: 'Dành cho macOS 12 trở lên, Apple silicon và Intel. Bản Windows x64 đang hoàn thiện.',
    watch: 'Xem video',
    github: 'Mã nguồn trên GitHub',
    facts: ['Miễn phí, giấy phép MIT', 'Dùng gói VPN của bạn', 'Không telemetry'],
  },
  board: {
    label: 'Minh hoạ cách Proxy Farm nối cổng với máy chủ',
    caption: 'Minh hoạ. Địa chỉ IP là dải dành cho tài liệu.',
    ports: 'Cổng trên máy bạn · 127.0.0.1',
    servers: 'Máy chủ VPN',
    changeIp: 'Đổi IP',
    changeIpFor: (port) => `Đổi IP cho cổng ${port}`,
    noFree: 'Vị trí này không còn máy chủ trống',
    moved: (port, ip) => `Cổng ${port} đã chuyển sang máy chủ khác. IP thoát mới: ${ip}`,
    free: 'trống',
    exit: 'IP thoát',
  },
  demo: {
    title: 'Xem Proxy Farm chạy thật',
    body: 'Từ lúc thêm tài khoản VPN đến khi có cổng proxy đang chạy, quay trực tiếp từ ứng dụng.',
    pending: 'Video đang được hoàn thiện',
    pendingNote: 'Trong lúc chờ, ảnh chụp thật của ứng dụng nằm ngay bên dưới.',
    transcript: 'Phụ đề tiếng Việt và tiếng Anh có sẵn trong trình phát.',
  },
  how: {
    title: 'Ba bước, không cần terminal',
    lede: 'Mọi thứ diễn ra trong một ứng dụng máy tính. Bạn không cần dựng máy chủ hay sửa cấu hình mạng.',
    steps: [
      {
        title: 'Kết nối gói VPN của bạn',
        body: 'Chọn nhà cung cấp và nhập thông tin mà chính nhà cung cấp cấp cho bạn. Mỗi thẻ có hướng dẫn lấy thông tin đó. Với HMA, ứng dụng tự đọc thông tin của app HMA trên cùng máy.',
        alt: 'Màn hình thêm nhà cung cấp VPN của Proxy Farm',
      },
      {
        title: 'Chọn vị trí và số cổng',
        body: 'Tìm thành phố, chọn bao nhiêu cổng cho mỗi nơi. Mỗi cổng được ghim vào một máy chủ riêng của vị trí đó.',
        alt: 'Bảng chọn vị trí của Proxy Farm, lọc theo nhà cung cấp',
      },
      {
        title: 'Dán proxy vào công cụ của bạn',
        body: 'Khi cổng báo Đang hoạt động, sao chép dạng host:port:user:pass, socks5://, hoặc lệnh curl, rồi dán vào trình duyệt, hồ sơ antidetect hay script.',
        alt: 'Danh sách cổng của Proxy Farm với trạng thái, IP thoát và độ trễ',
      },
    ],
  },
  features: {
    title: 'Làm ít việc, nhưng làm đúng',
    lede: 'Những gì ứng dụng thật sự làm, theo đúng tài liệu của dự án. Mục đánh dấu “Bản tới” đã có trong mã nguồn nhưng chưa nằm trong bản phát hành hiện tại (v0.1.1).',
    nextTag: 'Bản tới',
    groups: [
      {
        title: 'Mỗi cổng một IP',
        rows: [
          { title: 'Một cổng, một máy chủ, một IP thoát', body: 'Mỗi cổng chạy đường hầm riêng tới một máy chủ VPN. Một vị trí có nhiều máy chủ thì giữ được nhiều cổng, mỗi cổng một IP khác nhau.' },
          { title: 'SOCKS5 và HTTP trên cùng một cổng', body: 'Mỗi cổng phục vụ cả hai giao thức, kèm tên đăng nhập và mật khẩu proxy tạo sẵn ở lần chạy đầu.' },
          { title: 'IP bám máy chủ', body: 'Cổng bị rớt sẽ thử lại đúng máy chủ cũ trước. Nó chỉ chuyển máy chủ khi máy chủ đó chết hoặc từ chối tài khoản của bạn.' },
        ],
      },
      {
        title: 'Đổi IP khi bạn cần',
        rows: [
          { title: 'Đổi IP', body: 'Chuyển một cổng sang máy chủ trống khác cùng vị trí, rồi kiểm tra lại để xác nhận IP thoát đã thật sự đổi.' },
          { title: 'Tự xoay theo chu kỳ', body: 'Đặt cổng tự đổi IP sau mỗi N phút. Có webhook xoay IP tuỳ chọn cho script, mặc định tắt.' },
        ],
      },
      {
        title: 'Biết cổng nào đang sống',
        rows: [
          { title: 'Trạng thái từng cổng', body: 'Đang kết nối, đang hoạt động, thử lại kèm đếm ngược và lý do, hoặc lỗi kèm hướng xử lý. Có IP thoát, quốc gia và độ trễ.' },
          { title: 'Lọc cổng sống/chết và Kiểm tra tất cả', body: 'Lọc nhanh các cổng đang lỗi và kiểm tra lại toàn bộ trong một lần bấm.', next: true },
          { title: 'Xuất proxy', body: 'Xuất theo dạng host:port:user:pass, socks5://, host:port hoặc curl.' },
          { title: 'Xuất CSV và lưu ra tệp', body: 'Lưu danh sách proxy thành tệp CSV hoặc tệp văn bản.', next: true },
        ],
      },
      {
        title: 'Chạy trên máy bạn',
        rows: [
          { title: 'Không admin, không VPN hệ thống', body: 'Mỗi cổng chạy một tiến trình sing-box nguyên bản ở chế độ userspace: không TUN, không driver, không đổi bảng định tuyến.' },
          { title: 'Không rò về mạng thật', body: 'Lối ra duy nhất của một cổng là đường hầm của nó. Đường hầm rớt thì proxy báo lỗi, không lặng lẽ đi bằng mạng nhà bạn.' },
          { title: 'Bí mật được mã hoá, không telemetry', body: 'Mật khẩu và khoá được mã hoá bằng kho khoá của hệ điều hành. Ứng dụng không gửi số liệu sử dụng về đâu cả.' },
        ],
      },
    ],
  },
  providers: {
    title: 'Dùng gói VPN bạn đã có',
    lede: 'Proxy Farm không bán IP hay quyền truy cập VPN. Bạn mang tài khoản của mình, ứng dụng biến nó thành các cổng proxy.',
    cols: { provider: 'Nhà cung cấp', signIn: 'Bạn nhập', protocol: 'Giao thức' },
    list: [
      { name: 'HMA', key: 'hma', signIn: 'Không cần nhập gì: ứng dụng đọc thông tin thiết bị của app HMA cài trên cùng máy', protocol: 'OpenVPN', note: 'Hiện chỉ trên macOS' },
      { name: 'ZoogVPN', key: 'zoogvpn', signIn: 'Email và mật khẩu tài khoản', protocol: 'OpenVPN' },
      { name: 'Surfshark', key: 'surfshark', signIn: 'Khoá riêng WireGuard từ trang cài đặt thủ công', protocol: 'WireGuard' },
      { name: 'NordVPN', key: 'nordvpn', signIn: 'Access token từ Nord Account, hoặc khoá NordLynx', protocol: 'WireGuard (NordLynx)', next: true },
      { name: 'ExpressVPN', key: 'expressvpn', signIn: 'Tên đăng nhập và mật khẩu ở trang Manual configuration → OpenVPN', protocol: 'OpenVPN', next: true },
      { name: 'Tệp cấu hình', key: 'file', signIn: 'Tệp .ovpn hoặc .conf của WireGuard, từ nhà cung cấp khác hay máy chủ của bạn', protocol: 'OpenVPN / WireGuard' },
    ],
    footnote: 'Proxy Farm không liên kết với bất kỳ nhà cung cấp VPN nào. Tên nhà cung cấp là nhãn hiệu của chủ sở hữu.',
  },
  screens: {
    title: 'Ảnh chụp thật từ ứng dụng',
    lede: 'Giao diện tiếng Việt và tiếng Anh, chủ đề sáng và tối. Ảnh không qua chỉnh sửa.',
    light: 'Sáng',
    dark: 'Tối',
    altMain: 'Màn hình Cổng của Proxy Farm: trạng thái, vị trí, cổng cục bộ, IP thoát, độ trễ và nút Xoay IP',
    altPools: 'Nhóm máy chủ theo vị trí: Miami có bốn máy chủ, ba cổng đang chạy và menu Đổi IP chọn máy chủ trống',
    poolsCaption: 'Nhóm máy chủ: một vị trí giữ nhiều cổng, menu Đổi IP cho biết máy chủ nào còn trống.',
    real: 'Ảnh chụp màn hình thật',
  },
  useCases: {
    title: 'Ai đang cần điều này',
    list: [
      { who: 'Bạn đã trả tiền cho một gói VPN', body: 'Dùng lại chính gói đó làm proxy cho từng ứng dụng và trình duyệt, thay vì cả máy đi qua một VPN.', example: ['Trình duyệt công việc', '127.0.0.1:29001 · Tokyo'] },
      { who: 'MMO, marketing, nhiều tài khoản', body: 'Mỗi tài khoản hay hồ sơ trình duyệt gắn với một cổng, nên luôn ra cùng một IP, tách biệt với các hồ sơ khác.', example: ['Hồ sơ #12', '127.0.0.1:29012'] },
      { who: 'Thu thập dữ liệu và nghiên cứu', body: 'Theo dõi giá, kiểm tra thứ hạng SEO theo vùng, thu thập dữ liệu từ nhiều vị trí cùng lúc.', example: ['Scraper', ':29001–29008'] },
      { who: 'Lập trình viên và QA', body: 'Kiểm tra nội dung, giá và quảng cáo theo từng quốc gia mà không đổi mạng của cả máy.', example: ['curl', '-x socks5h://…@127.0.0.1:29003'] },
    ],
  },
  download: {
    title: 'Tải Proxy Farm',
    lede: 'Bản cài đặt sẽ có tại đây và trên GitHub Releases. Ứng dụng tự cập nhật từ GitHub.',
    targets: {
      'mac-arm64': { name: 'macOS · Apple silicon', detail: 'macOS 12 trở lên, chip M' },
      'mac-x64': { name: 'macOS · Intel', detail: 'macOS 12 trở lên' },
      'win-x64': { name: 'Windows · x64', detail: 'Bản 64-bit' },
    },
    soon: 'Sắp ra mắt',
    get: 'Tải về',
    releases: 'Theo dõi bản phát hành trên GitHub',
    build: 'Hoặc tự build từ mã nguồn',
  },
  faq: {
    title: 'Câu hỏi thường gặp',
    list: [
      { q: 'Proxy Farm có bán IP hay VPN không?', a: 'Không. Bạn cần một gói VPN của riêng mình (hoặc tệp .ovpn/.conf). Proxy Farm chỉ biến gói đó thành các cổng proxy trên máy bạn.' },
      { q: 'Dùng như vậy có vi phạm điều khoản của nhà cung cấp VPN không?', a: 'Có thể. Nhiều nhà cung cấp cấm chia sẻ hoặc bán lại kết nối, và việc mở nhiều đường hầm cùng lúc có thể kích hoạt cơ chế chống lạm dụng, dẫn tới khoá tài khoản. Hãy dùng cho chính bạn, đừng mở proxy ra internet hay chia cho người khác, và tự đọc điều khoản của nhà cung cấp.' },
      { q: 'Chạy trên hệ điều hành nào?', a: 'macOS 12 trở lên, cả Apple silicon lẫn Intel. Bản Windows x64 đã hoàn thiện mã nhưng chưa phát hành. HMA hiện chỉ dùng được trên macOS.' },
      { q: 'Có mất phí không?', a: 'Không. Proxy Farm miễn phí, mã nguồn mở theo giấy phép MIT. Ứng dụng đi kèm sing-box (GPL-3.0) dưới dạng chương trình riêng, không chỉnh sửa.' },
      { q: 'Một gói VPN cho được bao nhiêu cổng?', a: 'Tuỳ số máy chủ của vị trí và giới hạn thiết bị của gói. Mỗi cổng cần một máy chủ trống. Ứng dụng đặt sẵn giới hạn an toàn cho một số nhà cung cấp, ví dụ 8 cổng cho ExpressVPN để chừa thiết bị cho bạn, và bạn tự chỉnh được.' },
      { q: 'Ứng dụng có thu thập dữ liệu của tôi không?', a: 'Không. Không telemetry, không phân tích, không tài khoản với chúng tôi. Ứng dụng chỉ kết nối tới máy chủ VPN của bạn và vài dịch vụ được liệt kê kèm lý do trong PRIVACY.md.' },
      { q: 'Có ảnh hưởng tới mạng của máy tôi không?', a: 'Không. Proxy Farm không bật VPN hệ thống, không cài driver và không đổi bảng định tuyến. Mạng của máy vẫn như cũ; chỉ ứng dụng nào dùng proxy mới đi qua VPN.' },
      { q: 'Dùng proxy từ máy khác trong nhà được không?', a: 'Được, nếu bạn bật Chia sẻ trong mạng LAN trong Cài đặt. Khi đó proxy bắt buộc có mật khẩu, và bạn nên giữ các cổng sau tường lửa.' },
    ],
  },
  support: {
    title: 'Hỗ trợ qua GitHub',
    lede: 'Dự án không có email hay gói hỗ trợ trả phí. Mọi câu hỏi và báo lỗi đều công khai trên GitHub.',
    discussions: 'Hỏi đáp',
    discussionsBody: 'Câu hỏi về cách dùng, ý tưởng, chia sẻ cấu hình.',
    issues: 'Báo lỗi',
    issuesBody: 'Mô tả lỗi, kèm phiên bản và nhật ký đã che thông tin bí mật.',
    security: 'Báo lỗ hổng bảo mật',
    securityBody: 'Báo riêng tư theo SECURITY.md, đừng đăng công khai.',
  },
  footer: {
    by: 'Proxy Farm by LingoReUp',
    privacy: 'Quyền riêng tư',
    disclaimer: 'Miễn trừ trách nhiệm',
    license: 'Giấy phép MIT',
    changelog: 'Nhật ký thay đổi',
    notice: 'Bạn tự chịu trách nhiệm tuân thủ điều khoản của nhà cung cấp VPN và pháp luật nơi bạn sống. Phần mềm được cung cấp “nguyên trạng”, không kèm bảo đảm.',
    trademarks: 'Proxy Farm không liên kết với HMA, Gen Digital, ZoogVPN, Surfshark, NordVPN, Nord Security, ExpressVPN hay bất kỳ nhà cung cấp VPN nào. Các tên này là nhãn hiệu của chủ sở hữu.',
  },
};

const en: Copy = {
  htmlLang: 'en',
  ogLocale: 'en_US',
  meta: {
    title: 'Proxy Farm: turn your VPN into SOCKS5/HTTP proxies',
    description:
      'Free, open-source desktop app that turns your VPN subscription into many local SOCKS5/HTTP proxies, each port with its own fixed IP. No Docker, no admin.',
    ogAlt: 'Proxy Farm: each local proxy port wired to one VPN server, one fixed IP',
  },
  skip: 'Skip to main content',
  nav: { how: 'How it works', features: 'Features', screens: 'Screenshots', faq: 'FAQ', download: 'Download', menu: 'Menu' },
  langSwitch: { label: 'Language', other: 'Tiếng Việt', otherShort: 'VI' },
  hero: {
    title: 'Turn your VPN subscription into dozens of proxies.',
    titleSub: 'Each port keeps its own fixed IP.',
    lede:
      'Proxy Farm runs on your computer and opens local SOCKS5/HTTP ports. Each port is its own tunnel to exactly one VPN server. No Docker, no terminal, no admin rights.',
    download: 'Download',
    soon: 'Coming soon',
    platforms: 'For macOS 12 or later, Apple silicon and Intel. The Windows x64 build is being finished.',
    watch: 'Watch the demo',
    github: 'Source on GitHub',
    facts: ['Free, MIT licensed', 'Uses your own VPN plan', 'No telemetry'],
  },
  board: {
    label: 'Illustration of how Proxy Farm wires ports to servers',
    caption: 'Illustration. IP addresses are from documentation ranges.',
    ports: 'Ports on your computer · 127.0.0.1',
    servers: 'VPN servers',
    changeIp: 'Change IP',
    changeIpFor: (port) => `Change IP for port ${port}`,
    noFree: 'No free server left at this location',
    moved: (port, ip) => `Port ${port} moved to another server. New exit IP: ${ip}`,
    free: 'free',
    exit: 'Exit IP',
  },
  demo: {
    title: 'See Proxy Farm working',
    body: 'From adding a VPN account to a running proxy port, recorded straight from the app.',
    pending: 'The video is being finished',
    pendingNote: 'Meanwhile, real screenshots of the app are just below.',
    transcript: 'Vietnamese and English captions are available in the player.',
  },
  how: {
    title: 'Three steps, no terminal',
    lede: 'Everything happens in one desktop app. You do not set up a server or change your network settings.',
    steps: [
      {
        title: 'Connect your VPN subscription',
        body: 'Pick a provider and enter the credential that provider gives you. Each card has a guide for getting it. For HMA, the app reads the credentials of the HMA app on the same computer.',
        alt: 'Proxy Farm screen for adding a VPN provider',
      },
      {
        title: 'Pick locations and port counts',
        body: 'Search for a city and choose how many ports it gets. Each port is pinned to its own server at that location.',
        alt: 'Proxy Farm location picker, filtered by provider',
      },
      {
        title: 'Paste the proxies into your tools',
        body: 'When a port shows Online, copy it as host:port:user:pass, a socks5:// URL or a curl command, and paste it into a browser, an anti-detect profile or a script.',
        alt: 'Proxy Farm port list with status, exit IP and latency',
      },
    ],
  },
  features: {
    title: 'Does a few things, and does them right',
    lede: 'What the app actually does, as documented by the project. Items marked “Next release” are in the source code but not in the current release (v0.1.1).',
    nextTag: 'Next release',
    groups: [
      {
        title: 'One IP per port',
        rows: [
          { title: 'One port, one server, one exit IP', body: 'Each port runs its own tunnel to one VPN server. A location with several servers holds several ports, each with a different IP.' },
          { title: 'SOCKS5 and HTTP on the same port', body: 'Every port serves both protocols, with a proxy username and password generated on first run.' },
          { title: 'Sticky exit IPs', body: 'A dropped port retries the same server first. It moves only when that server is dead or refuses your account.' },
        ],
      },
      {
        title: 'Change IP when you choose',
        rows: [
          { title: 'Change IP', body: 'Moves a port to another free server of the same location, then checks that the exit IP really changed.' },
          { title: 'Auto-rotate', body: 'Rotate a port every N minutes. An optional rotate webhook for scripts is off by default.' },
        ],
      },
      {
        title: 'Know which ports are alive',
        rows: [
          { title: 'Live status per port', body: 'Connecting, online, retrying with a countdown and the reason, or failed with guidance. Exit IP, country and latency.' },
          { title: 'Alive/dead filters and Check all', body: 'Filter the failing ports and re-check every port in one click.', next: true },
          { title: 'Export proxies', body: 'Export as host:port:user:pass, socks5://, host:port or curl.' },
          { title: 'CSV export and save to file', body: 'Save the proxy list as a CSV or text file.', next: true },
        ],
      },
      {
        title: 'Runs on your computer',
        rows: [
          { title: 'No admin, no system VPN', body: 'Each port runs its own unmodified sing-box process in userspace: no TUN device, no driver, no routing changes.' },
          { title: 'No leaks to your real connection', body: 'A port’s only way out is its tunnel. If the tunnel drops, the proxy fails instead of falling back to your home network.' },
          { title: 'Encrypted secrets, no telemetry', body: 'Passwords and keys are encrypted with your operating system’s key store. The app sends no usage data anywhere.' },
        ],
      },
    ],
  },
  providers: {
    title: 'Bring the VPN you already have',
    lede: 'Proxy Farm does not sell IPs or VPN access. You bring your own account; the app turns it into proxy ports.',
    cols: { provider: 'Provider', signIn: 'You enter', protocol: 'Protocol' },
    list: [
      { name: 'HMA', key: 'hma', signIn: 'Nothing: the app reads the device credentials of the HMA app on the same computer', protocol: 'OpenVPN', note: 'macOS only for now' },
      { name: 'ZoogVPN', key: 'zoogvpn', signIn: 'Account email and password', protocol: 'OpenVPN' },
      { name: 'Surfshark', key: 'surfshark', signIn: 'WireGuard private key from the manual setup page', protocol: 'WireGuard' },
      { name: 'NordVPN', key: 'nordvpn', signIn: 'An access token from Nord Account, or your NordLynx key', protocol: 'WireGuard (NordLynx)', next: true },
      { name: 'ExpressVPN', key: 'expressvpn', signIn: 'Username and password from Manual configuration → OpenVPN', protocol: 'OpenVPN', next: true },
      { name: 'Config file', key: 'file', signIn: 'An .ovpn or WireGuard .conf file, from another provider or your own server', protocol: 'OpenVPN / WireGuard' },
    ],
    footnote: 'Proxy Farm is not affiliated with any VPN provider. Provider names are trademarks of their owners.',
  },
  screens: {
    title: 'Real screenshots from the app',
    lede: 'English and Vietnamese interface, light and dark themes. No retouching.',
    light: 'Light',
    dark: 'Dark',
    altMain: 'Proxy Farm Ports screen: status, location, local port, exit IP, latency and Rotate IP',
    altPools: 'Server pools by location: Miami has four servers, three running ports and a Change IP menu listing the free server',
    poolsCaption: 'Server pools: one location holds several ports, and the Change IP menu shows which servers are free.',
    real: 'Real screenshot',
  },
  useCases: {
    title: 'Who this is for',
    list: [
      { who: 'You already pay for a VPN', body: 'Reuse that same plan as proxies for individual apps and browsers, instead of sending the whole computer through one VPN.', example: ['Work browser', '127.0.0.1:29001 · Tokyo'] },
      { who: 'MMO, marketing, many accounts', body: 'Bind each account or browser profile to one port, so it always leaves from the same IP, separate from the others.', example: ['Profile #12', '127.0.0.1:29012'] },
      { who: 'Data collection and research', body: 'Track prices, check regional SEO rankings and collect data from many locations at once.', example: ['Scraper', ':29001–29008'] },
      { who: 'Developers and QA', body: 'Test content, pricing and ads per country without changing the whole machine’s network.', example: ['curl', '-x socks5h://…@127.0.0.1:29003'] },
    ],
  },
  download: {
    title: 'Download Proxy Farm',
    lede: 'Installers will be here and on GitHub Releases. The app updates itself from GitHub.',
    targets: {
      'mac-arm64': { name: 'macOS · Apple silicon', detail: 'macOS 12 or later, M-series' },
      'mac-x64': { name: 'macOS · Intel', detail: 'macOS 12 or later' },
      'win-x64': { name: 'Windows · x64', detail: '64-bit build' },
    },
    soon: 'Coming soon',
    get: 'Download',
    releases: 'Watch releases on GitHub',
    build: 'Or build it from source',
  },
  faq: {
    title: 'Questions',
    list: [
      { q: 'Does Proxy Farm sell IPs or VPN access?', a: 'No. You need your own VPN subscription (or an .ovpn/.conf file). Proxy Farm only turns it into proxy ports on your computer.' },
      { q: 'Is this against my VPN provider’s terms?', a: 'It can be. Many providers forbid sharing or reselling connections, and many simultaneous tunnels can trigger abuse detection and get the account suspended. Use it for yourself, do not expose the proxies to the internet or share them, and read your provider’s terms.' },
      { q: 'Which operating systems does it run on?', a: 'macOS 12 or later, on Apple silicon and Intel. The Windows x64 build is code-complete but not released yet. HMA currently works on macOS only.' },
      { q: 'Does it cost anything?', a: 'No. Proxy Farm is free and open source under the MIT license. It bundles sing-box (GPL-3.0) as a separate, unmodified program.' },
      { q: 'How many ports can one VPN plan give me?', a: 'It depends on the location’s servers and your plan’s device limit. Each port needs a free server. The app sets safe defaults for some providers, such as 8 ports for ExpressVPN to leave devices for you, and you can change them.' },
      { q: 'Does the app collect my data?', a: 'No. No telemetry, no analytics, no account with us. The app talks only to your VPN servers and a few services listed with their reasons in PRIVACY.md.' },
      { q: 'Does it change my computer’s network?', a: 'No. Proxy Farm turns on no system VPN, installs no driver and changes no routes. Your network stays as it is; only apps you point at a proxy go through the VPN.' },
      { q: 'Can other devices at home use the proxies?', a: 'Yes, if you turn on Share on the local network in Settings. The proxies then require a password, and you should keep the ports behind a firewall.' },
    ],
  },
  support: {
    title: 'Support on GitHub',
    lede: 'There is no email and no paid support. Questions and bug reports happen in the open on GitHub.',
    discussions: 'Discussions',
    discussionsBody: 'Usage questions, ideas and setups.',
    issues: 'Issues',
    issuesBody: 'Bug reports, with the version and redacted logs.',
    security: 'Report a vulnerability',
    securityBody: 'Privately, as described in SECURITY.md. Never in a public issue.',
  },
  footer: {
    by: 'Proxy Farm by LingoReUp',
    privacy: 'Privacy',
    disclaimer: 'Disclaimer',
    license: 'MIT License',
    changelog: 'Changelog',
    notice: 'You are responsible for following your VPN provider’s terms and the laws where you live. The software is provided “as is”, without warranty.',
    trademarks: 'Proxy Farm is not affiliated with HMA, Gen Digital, ZoogVPN, Surfshark, NordVPN, Nord Security, ExpressVPN or any other VPN provider. These names are trademarks of their owners.',
  },
};

export const copy: Record<Lang, Copy> = { vi, en };
export const pathFor = (lang: Lang) => (lang === 'vi' ? '/' : '/en/');
