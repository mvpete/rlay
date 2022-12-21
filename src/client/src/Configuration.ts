export interface Configuration {
  localPort: number
  relayPort: number
  localHost: string
  relayHost: string
  password: string,
  alias ?:string, 
  type: "tcp" | "http"
  https: boolean
  outputBody: boolean
  version: string
}