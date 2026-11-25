export type SupportedLang = 'c' | 'cpp' | 'java' | 'python' | 'rust' | 'go';

export const LANG_ORDER: readonly SupportedLang[] = ['c', 'cpp', 'java', 'python', 'rust', 'go'];

export const LANG_FILES: Readonly<Record<SupportedLang, string>> = {
  c: 'main.c',
  cpp: 'main.cpp',
  java: 'Main.java',
  python: 'main.py',
  rust: 'main.rs',
  go: 'main.go',
};

export const LANG_LABELS: Readonly<Record<SupportedLang, string>> = {
  c: 'C',
  cpp: 'C++',
  java: 'Java',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
};

export const STARTER_CODE: Readonly<Record<SupportedLang, string>> = {
  c: `#include <stdio.h>

int main() {
    // read input from stdin, print the answer to stdout
    return 0;
}
`,
  cpp: `#include <bits/stdc++.h>
using namespace std;

int main() {
    // read input from stdin, print the answer to stdout
    return 0;
}
`,
  java: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        // read input, print the answer
    }
}
`,
  python: `def main():
    # read input with input(), print the answer
    pass


if __name__ == "__main__":
    main()
`,
  rust: `use std::io::{self, Read};

fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    // parse s and print the answer
}
`,
  go: `package main

import "fmt"

func main() {
    var n int
    fmt.Scan(&n)
    // read the rest and print the answer
}
`,
};

export function fileForLang(lang: string): string {
  return new Map<string, string>(Object.entries(LANG_FILES)).get(lang) ?? 'main.c';
}

export function labelForLang(lang: string): string {
  return new Map<string, string>(Object.entries(LANG_LABELS)).get(lang) ?? lang.toUpperCase();
}

export function starterForLang(lang: string): string {
  return new Map<string, string>(Object.entries(STARTER_CODE)).get(lang) ?? STARTER_CODE.c;
}
