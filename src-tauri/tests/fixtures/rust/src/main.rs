mod greeter;

use greeter::greet;

fn main() {
    let message = greet("world");
    println!("{message}");
}
