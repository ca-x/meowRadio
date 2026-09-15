# Radiobrowser Lib Rust
Client library for radio-browser.info and other radio-browser-rust servers

## Features
- [x] Async / Blocking API
- [x] Clean query api with builder pattern
- [x] Countries, languages, tags, stations, serverconfig
- [x] Server statistics
- [x] Station actions: click, vote
- [ ] Add streams

## Crate features
* "blocking" - support for non-async (blocking) mode
* "chrono" - return DateTime objects instead of strings

## Getting started (Blocking)
### Example:
It needs to have the feature "blocking" enabled.
Cargo.toml entry:
```toml
radiobrowser = { version = "*", features = ["blocking"] }
```
```rust
use radiobrowser::blocking::RadioBrowserAPI;
use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {
    let mut api = RadioBrowserAPI::new()?;
    let servers = RadioBrowserAPI::get_default_servers()?;
    println!("Servers: {:?}", servers);
    let status = api.get_server_status()?;
    println!("Status: {:?}", status);
    let countries = api.get_countries().send()?;
    println!("Countries: {:?}", countries);
    let stations = api.get_stations().name("jazz").send()?;
    println!("Stations: {:?}", stations);
    Ok(())
}
```

## Getting started (Async)
Cargo.toml entry
```toml
radiobrowser = "*"
```
### Example:
```rust
use radiobrowser::RadioBrowserAPI;
use radiobrowser::StationOrder;
use std::error::Error;

#[async_std::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut api = RadioBrowserAPI::new().await?;
    let stations = api
        .get_stations()
        .name("jazz")
        .reverse(true)
        .order(StationOrder::Clickcount)
        .send()
        .await?;

    println!("Stations found: {}", stations?.len());
    Ok(())
}
```

## Usage
Documentation is at https://docs.rs/radiobrowser

## License
This project is MIT licensed.
