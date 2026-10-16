// Phải được import ĐẦU TIÊN trong main.ts để OpenTelemetry kịp bọc http/express.
import { initMonitoring } from './monitoring'

initMonitoring()
